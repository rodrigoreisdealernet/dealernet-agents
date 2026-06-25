import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  navigateSpy,
  useDataSourcesMock,
  rpcMock,
  authState,
} = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  useDataSourcesMock: vi.fn(),
  rpcMock: vi.fn(),
  authState: {
    value: {
      profile: { id: 'user-1', displayName: 'Field Op', role: 'field_operator' },
      session: { access_token: 'token' },
    },
  },
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

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
  },
}));

vi.mock('@/auth/AuthContext', async () => {
  const types = await vi.importActual<typeof import('@/auth/types')>('@/auth/types');
  return {
    useAuth: () => authState.value,
    useAuthCapabilities: () => ({
      canWrite: types.canWrite(authState.value.profile?.role as import('@/auth/types').AppRole | undefined),
      canOperate: types.canOperate(authState.value.profile?.role as import('@/auth/types').AppRole | undefined),
      role: authState.value.profile?.role,
    }),
  };
});

import { initializeRegistry } from '@/registry';
import { UIEngine } from '@/engine';
import returnsCheckInPage from '@/pages/rental-returns-checkin.json';
import type { PageDefinition } from '@/engine/types';
import { RentalReturnsCheckInScreen } from '@/routes/rental/returns';
import { RentalContractDetailScreen } from '@/routes/rental/contracts/$id';

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

describe('rental returns/check-in screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    useDataSourcesMock.mockReset();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Field Op', role: 'field_operator' },
      session: { access_token: 'token' },
    };

    rpcMock.mockResolvedValue({ error: null });
  });

  it('renders checked-out contract lines and inspection hold assets', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        checked_out_lines: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-01T09:00:00Z',
            data: {
              category_id: 'cat-1',
              planned_end: '2026-06-05',
            },
          },
        ],
        contracts: [
          {
            entity_id: 'contract-1',
            data: {
              customer_id: 'customer-1',
              job_site_id: 'job-site-1',
            },
          },
        ],
        customers: [
          { entity_id: 'customer-1', name: 'Acme Construction' },
        ],
        job_sites: [
          {
            id: 'job-site-1',
            source_record_id: 'JS-101',
            entity_versions: [{ data: { name: 'Downtown Tower' }, is_current: true }],
          },
        ],
        asset_categories: [
          { asset_category_id: 'cat-1', asset_category_name: 'Excavators' },
        ],
        assets: [
          { asset_id: 'asset-1', name: 'CAT 320D #17' },
        ],
        inspection_holds: [
          {
            entity_id: 'line-hold-99',
            asset_id: 'asset-99',
            contract_id: 'contract-99',
            actual_end: '2026-06-01',
            data: { resulting_asset_status: 'on_inspection_hold' },
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalReturnsCheckInScreen />);

    expect(screen.getByRole('heading', { name: 'Returns / Check-In' })).toBeInTheDocument();
    expect(screen.getByText('Asset: CAT 320D #17')).toBeInTheDocument();
    expect(screen.getByText('Customer: Acme Construction • Job Site: Downtown Tower')).toBeInTheDocument();
    expect(screen.getByText('Category: Excavators')).toBeInTheDocument();
    expect(screen.getByText('Contract contract-1 • Asset asset-1')).toBeInTheDocument();
    expect(screen.getByText('Planned return: 2026-06-05')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check In This Line' })).toBeInTheDocument();
    expect(screen.getAllByText('asset-99').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('on_inspection_hold')).toBeInTheDocument();
  });

  it('captures return details and triggers check-in + inspection RPCs', async () => {
    const refetchMock = vi.fn();

    useDataSourcesMock.mockReturnValue({
      data: {
        checked_out_lines: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            data: { planned_end: '2026-06-05' },
          },
        ],
        inspection_holds: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: refetchMock,
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalReturnsCheckInScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Check In This Line' }));
    expect(screen.queryByLabelText('Contract Line Entity ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Contract ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Asset ID')).not.toBeInTheDocument();
    const checkInDialog = screen.getByRole('dialog');
    expect(within(checkInDialog).getByText('Contract contract-1 • Asset asset-1')).toBeInTheDocument();
    expect(within(checkInDialog).getByText('Line ID: line-1')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Return Date'), '2026-06-06');
    await userEvent.type(screen.getByLabelText('Return Notes'), 'Hydraulic leak found on return');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Check-In' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenNthCalledWith(
        1,
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_end: '2026-06-06',
            condition_outcome: 'pass',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenNthCalledWith(
        2,
        'create_entity_with_version',
        expect.objectContaining({
          p_entity_type: 'inspection',
          p_data: expect.objectContaining({
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'return',
            outcome: 'pass',
            resulting_asset_status: 'available',
            inspected_at: '2026-06-06',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('checked_out_lines');
      expect(refetchMock).toHaveBeenCalledWith('inspection_holds');
    });
  });

  it('keeps return modal focused on return-specific inputs', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        checked_out_lines: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-42',
            actual_start: '2026-06-01',
            data: { planned_end: '2026-06-05' },
          },
        ],
        inspection_holds: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalReturnsCheckInScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Check In This Line' }));

    const checkInDialog = screen.getByRole('dialog');
    expect(within(checkInDialog).getByText('Contract contract-1 • Asset asset-42')).toBeInTheDocument();
    expect(within(checkInDialog).getByText('Line ID: line-1')).toBeInTheDocument();
    expect(screen.getByLabelText('Return Date')).toBeInTheDocument();
    expect(screen.getByLabelText('Condition Outcome')).toBeInTheDocument();
    expect(screen.getByLabelText('Return Notes')).toBeInTheDocument();
    expect(screen.queryByLabelText('Contract Line Entity ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Contract ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Asset ID')).not.toBeInTheDocument();
  });

  it('preserves returned-line context and contract/asset linkage when IDs are omitted in form input', async () => {
    const refetchMock = vi.fn();

    useDataSourcesMock.mockReturnValue({
      data: {
        checked_out_lines: [
          {
            entity_id: 'line-2',
            status: 'checked_out',
            contract_id: 'contract-2',
            asset_id: 'asset-2',
            category_id: 'cat-2',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 9000,
            actual_start: '2026-06-03',
            actual_end: null,
            data: { planned_end: '2026-06-08' },
          },
        ],
        inspection_holds: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: refetchMock,
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalReturnsCheckInScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Check In This Line' }));
    await userEvent.type(screen.getByLabelText('Return Date'), '2026-06-09');
    await userEvent.type(screen.getByLabelText('Return Notes'), 'Hydraulic leak');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Check-In' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenNthCalledWith(
        1,
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-2',
          p_data: expect.objectContaining({
            status: 'returned',
            contract_id: 'contract-2',
            asset_id: 'asset-2',
            category_id: 'cat-2',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 9000,
            actual_start: '2026-06-03',
            actual_end: '2026-06-09',
            data: { planned_end: '2026-06-08' },
            condition_outcome: 'pass',
            resulting_asset_status: 'available',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenNthCalledWith(
        2,
        'create_entity_with_version',
        expect.objectContaining({
          p_entity_type: 'inspection',
          p_data: expect.objectContaining({
            asset_id: 'asset-2',
            contract_line_id: 'line-2',
            inspection_type: 'return',
            outcome: 'pass',
            resulting_asset_status: 'available',
            inspected_at: '2026-06-09',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('checked_out_lines');
      expect(refetchMock).toHaveBeenCalledWith('inspection_holds');
    });
  });

  it('removes the returns queue row on fail check-in and rebuilds returned-line detail after reload', async () => {
    const lineId = 'line-3';
    const contractId = 'contract-3';
    const assetId = 'asset-3';

    let checkedOutLines = [
      {
        entity_id: lineId,
        status: 'checked_out',
        contract_id: contractId,
        asset_id: assetId,
        category_id: 'cat-3',
        rental_type: 'external',
        rate_type: 'daily',
        rate_amount: 12000,
        actual_start: '2026-06-01',
        actual_end: null,
        data: { planned_end: '2026-06-07' },
      },
    ];
    let inspectionHolds: Array<{ entity_id: string; asset_id: string; contract_id: string; actual_end: string | null; data: { resulting_asset_status: string } }> = [];
    let capturedLinePayload: Record<string, unknown> | null = null;

    const refetchMock = vi.fn((source: string) => {
      if (source === 'checked_out_lines') {
        checkedOutLines = [];
      }
      if (source === 'inspection_holds') {
        inspectionHolds = [{ entity_id: 'line-hold-3', asset_id: assetId, contract_id: contractId, actual_end: '2026-06-08', data: { resulting_asset_status: 'on_inspection_hold' } }];
      }
    });

    useDataSourcesMock.mockImplementation((dataSources?: Record<string, unknown>) => {
      if (dataSources && 'lines' in dataSources) {
        return {
          data: {
            contract: {
              id: contractId,
              created_at: '2026-06-01T00:00:00Z',
              entity_type: 'rental_contract',
              entity_versions: [
                {
                  id: 'ver-contract-3',
                  version_number: 1,
                  is_current: true,
                  data: {
                    status: 'active',
                    rental_type: 'external',
                    contract_number: 'RC-003',
                    customer_id: 'customer-3',
                    job_site_id: 'job-site-3',
                  },
                },
              ],
            },
            lines: capturedLinePayload ? [capturedLinePayload] : [],
            contractInvoices: [],
            contractInvoiceRelationships: [],
          },
          isLoading: {},
          errors: {},
          isPageLoading: false,
          refetch: vi.fn(),
          refetchAll: vi.fn(),
        };
      }

      return {
        data: {
          checked_out_lines: checkedOutLines,
          inspection_holds: inspectionHolds,
        },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: refetchMock,
        refetchAll: vi.fn(),
      };
    });

    rpcMock.mockImplementation(async (fn: string, payload: Record<string, unknown>) => {
      if (fn === 'rental_upsert_entity_current_state') {
        capturedLinePayload = payload.p_data as Record<string, unknown>;
      }
      return { error: null };
    });

    const failOutcomeReturnsPage = JSON.parse(
      JSON.stringify(returnsCheckInPage)
    ) as PageDefinition;
    failOutcomeReturnsPage.state = {
      ...failOutcomeReturnsPage.state,
      checkIn_condition_outcome: 'fail',
    };
    // Keep fail default sticky in this harness so reopening the modal still submits fail
    // (the page click action sequence resets the field to "pass" before open).
    const stripConditionOutcomeReset = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(stripConditionOutcomeReset);
        return;
      }
      if (!node || typeof node !== 'object') return;

      const record = node as Record<string, unknown>;
      if (record.action === 'sequence' && Array.isArray(record.actions)) {
        record.actions = record.actions.filter(
          (action) =>
            !(
              action &&
              typeof action === 'object' &&
              (action as Record<string, unknown>).action === 'setState' &&
              (action as Record<string, unknown>).key === 'checkIn_condition_outcome'
            )
        );
      }

      Object.values(record).forEach(stripConditionOutcomeReset);
    };
    stripConditionOutcomeReset(failOutcomeReturnsPage);

    const { unmount } = renderWithQueryClient(
      <UIEngine page={failOutcomeReturnsPage} params={{}} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Check In This Line' }));
    await userEvent.type(screen.getByLabelText('Return Date'), '2026-06-08');
    await userEvent.type(screen.getByLabelText('Return Notes'), 'Engine leak found');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Check-In' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenNthCalledWith(
        1,
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: lineId,
          p_data: expect.objectContaining({
            status: 'returned',
            contract_id: contractId,
            asset_id: assetId,
            category_id: 'cat-3',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 12000,
            actual_start: '2026-06-01',
            actual_end: '2026-06-08',
            data: { planned_end: '2026-06-07' },
            condition_outcome: 'fail',
            resulting_asset_status: 'on_inspection_hold',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenNthCalledWith(
        2,
        'create_entity_with_version',
        expect.objectContaining({
          p_entity_type: 'inspection',
          p_data: expect.objectContaining({
            asset_id: assetId,
            contract_line_id: lineId,
            inspection_type: 'return',
            outcome: 'fail',
            resulting_asset_status: 'on_inspection_hold',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('checked_out_lines');
      expect(refetchMock).toHaveBeenCalledWith('inspection_holds');
    });

    unmount();
    const returnsReload = renderWithQueryClient(
      <UIEngine page={failOutcomeReturnsPage} params={{}} />
    );

    expect(screen.getByText('No checked-out lines pending return.')).toBeInTheDocument();
    expect(screen.getAllByText('asset-3').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('on_inspection_hold')).toBeInTheDocument();

    returnsReload.unmount();
    renderWithQueryClient(<RentalContractDetailScreen id={contractId} />);

    expect(screen.getByText('cat-3')).toBeInTheDocument();
    expect(screen.getByText(/Asset:\s*asset-3/)).toBeInTheDocument();
    expect(screen.getByText('returned')).toBeInTheDocument();
    expect(screen.getByText('Returned: 2026-06-08')).toBeInTheDocument();
    expect(screen.getByText('Planned return: 2026-06-07')).toBeInTheDocument();
  });
});
