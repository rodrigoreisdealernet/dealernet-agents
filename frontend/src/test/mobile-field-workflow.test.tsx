import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fromMock, rpcMock, storageFromMock, uploadMock, eqCallMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  storageFromMock: vi.fn(),
  uploadMock: vi.fn(),
  eqCallMock: vi.fn(),
}));

const { authState } = vi.hoisted(() => ({
  authState: {
    profile: {
      id: '00000000-0000-4000-8000-000000000001',
      role: 'field_operator' as 'admin' | 'branch_manager' | 'field_operator' | 'read_only',
    },
  },
}));
const TEST_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
    rpc: rpcMock,
    storage: {
      from: storageFromMock,
    },
  },
}));

import { MobileFieldWorkflowScreen, evaluateFieldWorkflow, loadInventorySummary, applyChecklistTemplate, CHECKLIST_TEMPLATES, resolveQuickOrderTask, resolveReturnScanCandidates, selectReturnCandidateWithContext } from '@/routes/field/mobile';
import type { ReturnSessionContext, FieldTask } from '@/routes/field/mobile';

type TableData = Record<string, unknown[]>;

function mockSupabaseTables(tableData: TableData) {
  fromMock.mockImplementation((table: string) => {
    const rows = tableData[table] ?? [];
    const result = { data: rows, error: null };
    const query = {
      select: vi.fn(),
      or: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    query.select.mockReturnValue(query);
    query.or.mockResolvedValue(result);
    query.eq.mockImplementation((column: string, value: unknown) => {
      eqCallMock(table, column, value);
      return Promise.resolve({
        data: rows.filter((row) => (row as Record<string, unknown>)[column] === value),
        error: null,
      });
    });
    query.in.mockResolvedValue(result);
    return query;
  });
}

function defaultTableData(overrides: TableData = {}): TableData {
  return {
    v_rental_contract_line_current: [
      {
        entity_id: 'line-1',
        status: 'pending',
        contract_id: 'contract-1',
        asset_id: 'asset-1',
        actual_start: null,
        actual_end: null,
        data: {
          planned_start: '2026-06-07T09:00:00.000Z',
          field_operator_id: TEST_OPERATOR_ID,
        },
      },
    ],
    v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', serial_number: 'TXR-42001', status: 'available' }],
    v_rental_contract_current: [
      { entity_id: 'contract-1', status: 'active', contract_number: 'RC-1001', data: { order_id: 'order-1' } },
    ],
    v_rental_order_current: [{ entity_id: 'order-1', status: 'active', data: { customer_id: 'cust-1', job_site_id: 'site-1' } }],
    rental_current_customers: [{ entity_id: 'cust-1', name: 'Acme Construction' }],
    rental_current_job_sites: [{ entity_id: 'site-1', name: 'Riverfront Jobsite' }],
    ...overrides,
  };
}

async function fillCheckoutConfirmLoadDetails() {
  await userEvent.type(screen.getByLabelText('Assigned driver'), 'Alex Driver');
  await userEvent.type(screen.getByLabelText('Assigned truck'), 'Truck-17');
  await userEvent.type(screen.getByLabelText('Departure timestamp'), '2026-06-08T09:30');
  await userEvent.type(screen.getByLabelText('Driver signature'), 'Alex Driver');
}

describe('mobile field rental workflow', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    authState.profile = { id: TEST_OPERATOR_ID, role: 'field_operator' };
    fromMock.mockReset();
    rpcMock.mockReset();
    storageFromMock.mockReset();
    uploadMock.mockReset();
    eqCallMock.mockReset();

    rpcMock.mockResolvedValue({ error: null });
    uploadMock.mockResolvedValue({ error: null });
    storageFromMock.mockReturnValue({ upload: uploadMock });

    mockSupabaseTables(defaultTableData());
  });

  it('renders a real task queue context and removes manual id/status inputs', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(
        screen.getByText((_, element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim() === 'Asset: Excavator 300')
      ).toBeInTheDocument();
    });

    expect(screen.getByText('Acme Construction - Riverfront Jobsite')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim() === 'Contract: RC-1001')
    ).toBeInTheDocument();

    expect(screen.queryByLabelText('Asset status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Contract status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Asset')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Contract')).not.toBeInTheDocument();
  });

  it('requires signature capture before submission', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete checkout' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Complete checkout' }));

    expect(
      screen.getByText('Field execution requires signature capture and operator confirmation.')
    ).toBeInTheDocument();
  });

  it('requires confirm-load fields before checkout submission', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete checkout' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Signature');
    await userEvent.click(screen.getByRole('button', { name: 'Complete checkout' }));

    expect(
      screen.getByText('Confirm load requires assigned driver, truck, departure timestamp, and driver signature.')
    ).toBeInTheDocument();
  });

  it('applies inspection fail transition to inspection_hold', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: '2026-06-07T09:00:00.000Z',
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', status: 'returned' }],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText('Inspection outcome')).toBeInTheDocument();
    });

    await userEvent.selectOptions(screen.getByLabelText('Inspection outcome'), 'fail');

    expect(screen.getByText('Completing this inspection transitions the asset to inspection_hold.')).toBeInTheDocument();
  });

  it('captures location metadata when browser geolocation is available', async () => {
    const geolocationSpy = vi.fn((success: PositionCallback) => {
      success({
        coords: {
          latitude: 51.5072,
          longitude: -0.1276,
          accuracy: 0,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
          toJSON: () => ({}),
        },
        timestamp: Date.now(),
        toJSON: () => ({}),
      } as GeolocationPosition);
    });

    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: {
        getCurrentPosition: geolocationSpy,
      },
    });

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Capture location metadata' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Capture location metadata' }));

    expect(screen.getByText('Location captured from browser permissions.')).toBeInTheDocument();
    expect(screen.getByText('Current location: 51.50720, -0.12760')).toBeInTheDocument();
  });

  it('persists asset state transition after checkout submit', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'pending',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: null,
            actual_end: null,
            data: {
              planned_start: '2026-06-07T09:00:00.000Z',
              field_operator_id: TEST_OPERATOR_ID,
              project_context_id: 'project-riverfront',
              cost_code: 'CC-101',
            },
          },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete checkout' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Signature');
    await fillCheckoutConfirmLoadDetails();
    await userEvent.click(screen.getByRole('button', { name: 'Complete checkout' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            status: 'checked_out',
            confirm_load: expect.objectContaining({
              assigned_driver: 'Alex Driver',
              assigned_truck: 'Truck-17',
              driver_signature: 'Alex Driver',
              departure_at: expect.any(String),
            }),
            project_context_id: 'project-riverfront',
            cost_code: 'CC-101',
            field_evidence: expect.objectContaining({
              approval_event_type: 'delivery',
              signature: 'Operator Signature',
            }),
          }),
        })
      );
      expect(rpcMock).toHaveBeenCalledWith('rental_upsert_entity_current_state', {
        p_entity_type: 'asset',
        p_entity_id: 'asset-1',
        p_data: expect.objectContaining({
          status: 'on_rent',
          last_field_workflow: 'checkout',
        }),
      });
    });
  });

  it('prevents read-only users from submitting approvals', async () => {
    authState.profile = { id: TEST_OPERATOR_ID, role: 'read_only' };
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText('Read-only role')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Complete checkout' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeDisabled();
  });

  it('preserves assignment metadata on return submit', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: {
              field_operator_id: TEST_OPERATOR_ID,
              assigned_operator_id: '00000000-0000-4000-8000-000000000002',
            },
          },
        ],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', status: 'on_rent' }],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Signature');
    await userEvent.click(screen.getByRole('button', { name: 'Complete return' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            status: 'returned',
            field_operator_id: TEST_OPERATOR_ID,
            assigned_operator_id: '00000000-0000-4000-8000-000000000002',
          }),
        })
      );
    });
  });

  it('preserves existing contract-line state fields when submitting a return', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: {
              field_operator_id: TEST_OPERATOR_ID,
              planned_end: '2026-06-10T17:00:00.000Z',
              downtime_minutes: 30,
            },
          },
        ],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', status: 'on_rent' }],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Signature');
    await userEvent.click(screen.getByRole('button', { name: 'Complete return' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            status: 'returned',
            planned_end: '2026-06-10T17:00:00.000Z',
            downtime_minutes: 30,
          }),
        })
      );
    });
  });

  it('preserves existing asset state fields when submitting a return', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [
          {
            asset_id: 'asset-1',
            name: 'Excavator 300',
            status: 'on_rent',
            state: {
              name: 'Excavator 300',
              serial_number: 'TXR-42001',
              status: 'on_rent',
            },
          },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Signature');
    await userEvent.click(screen.getByRole('button', { name: 'Complete return' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'asset',
          p_entity_id: 'asset-1',
          p_data: expect.objectContaining({
            name: 'Excavator 300',
            serial_number: 'TXR-42001',
            status: 'returned',
          }),
        })
      );
    });
  });

  it('persists inspection evidence onto the contract-line state', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: '2026-06-07T09:00:00.000Z',
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', status: 'returned' }],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete inspection' })).toBeInTheDocument();
    });

    await userEvent.selectOptions(screen.getByLabelText('Inspection outcome'), 'fail');
    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Signature');
    await userEvent.click(screen.getByRole('button', { name: 'Complete inspection' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            status: 'returned',
            condition_outcome: 'fail',
            resulting_asset_status: 'on_inspection_hold',
            field_evidence: expect.objectContaining({
              signature: 'Operator Signature',
            }),
          }),
        })
      );
    });
  });

  it('uses persisted line state when asset status is missing after reload', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: '2026-06-07T09:00:00.000Z',
            data: {
              field_operator_id: TEST_OPERATOR_ID,
              resulting_asset_status: 'on_inspection_hold',
            },
          },
        ],
        v_current_assets: [],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText(/Asset:\s*Inspection hold/i)).toBeInTheDocument();
    });
  });

  it('uses persisted inspection line status when asset row is stale after reload', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: '2026-06-07T09:00:00.000Z',
            data: {
              field_operator_id: TEST_OPERATOR_ID,
              resulting_asset_status: 'on_inspection_hold',
            },
          },
        ],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', status: 'returned' }],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText(/Asset:\s*Inspection hold/i)).toBeInTheDocument();
    });
  });

  it('inspection task shows Returned status badge when asset is in post-return state', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: '2026-06-07T09:00:00.000Z',
            data: {
              field_operator_id: TEST_OPERATOR_ID,
              resulting_asset_status: 'returned',
            },
          },
        ],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', status: 'returned' }],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText(/Asset:\s*Returned/i)).toBeInTheDocument();
    });
  });

  it('renders Field Task Queue as an accessible heading', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Field Task Queue' })).toBeInTheDocument();
    });
  });
});

describe('evaluateFieldWorkflow', () => {
  it('returns return/check-in blocked reason for non-rented assets', () => {
    const evaluation = evaluateFieldWorkflow({
      workflow: 'return',
      assetStatus: 'available',
      contractStatus: 'active',
      downtimeMinutes: 0,
      inspectionType: 'return',
      inspectionOutcome: 'pass',
    });

    expect(evaluation.blockedReasons).toContain('Return blocked: asset must be on_rent, current state is available.');
  });
});

describe('inventory view', () => {
  beforeEach(() => {
    fromMock.mockReset();
    rpcMock.mockReset();
    storageFromMock.mockReset();
    uploadMock.mockReset();
    eqCallMock.mockReset();

    rpcMock.mockResolvedValue({ error: null });
    uploadMock.mockResolvedValue({ error: null });
    storageFromMock.mockReturnValue({ upload: uploadMock });

    mockSupabaseTables(defaultTableData());
  });

  it('renders inventory status panel with live asset counts', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_current_assets: [
          { asset_id: 'asset-1', name: 'Excavator 300', status: 'available' },
          { asset_id: 'asset-2', name: 'Loader 100', status: 'on_rent' },
          { asset_id: 'asset-3', name: 'Crane 50', status: 'on_inspection_hold' },
          { asset_id: 'asset-4', name: 'Forklift 20', status: 'in_transit' },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText('Inventory status')).toBeInTheDocument();
    });

    expect(screen.getByText('Real-time asset counts across all statuses.')).toBeInTheDocument();
    // Total = 4, verify the count tile
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    // Use getAllByText because the Select dropdown also renders "Available"
    expect(screen.getAllByText('Available').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('On rent')).toBeInTheDocument();
    expect(screen.getByText('Inspection hold')).toBeInTheDocument();
    expect(screen.getByText('In transit')).toBeInTheDocument();
  });

  it('shows inventory adjust form', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText('Inventory adjust')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Asset ID')).toBeInTheDocument();
    expect(screen.getByLabelText('QR / barcode scan')).toBeInTheDocument();
    expect(screen.getByLabelText('New status')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason for adjustment')).toBeInTheDocument();
    expect(screen.getByLabelText('Asset image')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeInTheDocument();
  });

  it('requires asset ID before applying inventory adjustment', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Apply adjustment' }));

    expect(screen.getByText('Enter an asset ID or scan a QR/barcode.')).toBeInTheDocument();
  });

  it('requires a reason before applying inventory adjustment', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Asset ID'), 'asset-1');
    await userEvent.click(screen.getByRole('button', { name: 'Apply adjustment' }));

    expect(screen.getByText('Enter a reason for the status adjustment.')).toBeInTheDocument();
  });

  it('calls rental_upsert_entity_current_state with adjusted status and reason', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Asset ID'), 'asset-99');
    await userEvent.type(screen.getByLabelText('Reason for adjustment'), 'Spot-count correction');
    await userEvent.click(screen.getByRole('button', { name: 'Apply adjustment' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rental_upsert_entity_current_state', {
        p_entity_type: 'asset',
        p_entity_id: 'asset-99',
        p_data: expect.objectContaining({
          status: 'available',
          inventory_adjustment_reason: 'Spot-count correction',
        }),
      });
    });

    expect(screen.getByText('Asset status updated to Available.')).toBeInTheDocument();
  });

  it('resolves asset ID from a barcode scan and uploads photo evidence for inventory adjustment', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeInTheDocument();
    });

    const evidencePhoto = new File(['photo-bytes'], 'loader tag.png', { type: 'image/png' });

    await userEvent.type(screen.getByLabelText('QR / barcode scan'), 'TXR-42001');
    await userEvent.type(screen.getByLabelText('Reason for adjustment'), 'Found during yard walk');
    await userEvent.upload(screen.getByLabelText('Asset image'), evidencePhoto);
    await userEvent.click(screen.getByRole('button', { name: 'Apply adjustment' }));

    await waitFor(() => {
      expect(eqCallMock).toHaveBeenCalledWith('v_current_assets', 'serial_number', 'TXR-42001');
      expect(uploadMock).toHaveBeenCalledWith(
        expect.stringMatching(/^inventory-adjust\/asset-1\/.+-loader_tag\.png$/),
        evidencePhoto
      );
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'asset',
          p_entity_id: 'asset-1',
          p_data: expect.objectContaining({
            status: 'available',
            inventory_adjustment_reason: 'Found during yard walk',
            inventory_adjustment_scan_value: 'TXR-42001',
            inventory_adjustment_photo_paths: [expect.stringMatching(/^inventory-adjust\/asset-1\/.+-loader_tag\.png$/)],
            inventory_adjustment_captured_at: expect.any(String),
          }),
        })
      );
    });

    expect(screen.getByText('Asset status updated to Available. (scan captured, 1 photo attached)')).toBeInTheDocument();
  });
});

describe('loadInventorySummary', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it('counts assets by normalized status', async () => {
    mockSupabaseTables({
      v_current_assets: [
        { asset_id: 'a1', status: 'available' },
        { asset_id: 'a2', status: 'available' },
        { asset_id: 'a3', status: 'on_rent' },
        { asset_id: 'a4', status: 'on_inspection_hold' },
        { asset_id: 'a5', status: 'returned' },
        { asset_id: 'a6', status: 'maintenance' },
        { asset_id: 'a7', status: 'in_transit' },
      ],
    });

    const summary = await loadInventorySummary();

    expect(summary.total).toBe(7);
    expect(summary.available).toBe(2);
    expect(summary.on_rent).toBe(1);
    expect(summary.inspection_hold).toBe(1);
    expect(summary.returned).toBe(1);
    expect(summary.maintenance).toBe(1);
    expect(summary.in_transit).toBe(1);
  });

  it('throws when supabase returns an error', async () => {
    fromMock.mockImplementation(() => {
      const query = {
        select: vi.fn(),
        then: (resolve: (value: { data: null; error: Error }) => unknown) =>
          Promise.resolve({ data: null, error: new Error('DB error') }).then(resolve),
      };
      query.select.mockReturnValue(query);
      return query;
    });

    await expect(loadInventorySummary()).rejects.toThrow('DB error');
  });
});

describe('applyChecklistTemplate', () => {
  it('returns excavator items for a matching category name', () => {
    const items = applyChecklistTemplate('Excavators', 'pickup');
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((i) => i.status === 'pending')).toBe(true);
    expect(items.some((i) => i.key === 'engine_oil')).toBe(true);
    expect(items.some((i) => i.key === 'track_condition')).toBe(true);
    expect(items.some((i) => i.key === 'emergency_stop')).toBe(true);
  });

  it('returns forklift items for a case-insensitive match', () => {
    const items = applyChecklistTemplate('FORKLIFTS', 'return');
    expect(items.some((i) => i.key === 'fork_blades')).toBe(true);
    expect(items.some((i) => i.key === 'overhead_guard')).toBe(true);
  });

  it('falls back to the default template for an unknown category', () => {
    const items = applyChecklistTemplate('Unknown Equipment Type', 'return');
    expect(items.some((i) => i.key === 'general_condition')).toBe(true);
    expect(items.some((i) => i.key === 'no_visible_leaks')).toBe(true);
  });

  it('uses the default template when category name is empty', () => {
    const items = applyChecklistTemplate('', 'return');
    expect(items.some((i) => i.key === 'general_condition')).toBe(true);
  });

  it('all returned items start with pending status and empty note', () => {
    const items = applyChecklistTemplate('Cranes', 'pickup');
    for (const item of items) {
      expect(item.status).toBe('pending');
      expect(item.note).toBe('');
    }
  });

  it('merges tenant-provided items without duplicating existing keys', () => {
    const tenantItems = [
      { key: 'engine_oil', label: 'Tenant override - engine oil', section: 'Fluid Levels', required: true },
      { key: 'custom_check', label: 'Custom tenant item', section: 'Custom', required: false },
    ];
    const items = applyChecklistTemplate('Excavators', 'pickup', tenantItems);
    const engineOilItems = items.filter((i) => i.key === 'engine_oil');
    expect(engineOilItems).toHaveLength(1);
    expect(engineOilItems[0].label).toBe('Tenant override - engine oil');
    expect(items.some((i) => i.key === 'custom_check')).toBe(true);
  });

  it('covers all template category patterns', () => {
    const categoryPatterns = CHECKLIST_TEMPLATES.map((t) => t.categoryPattern);
    expect(categoryPatterns.length).toBeGreaterThan(0);
    expect(categoryPatterns[categoryPatterns.length - 1].test('anything')).toBe(true);
  });
});

describe('inspection checklist UI', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    authState.profile = { id: TEST_OPERATOR_ID, role: 'field_operator' };
    fromMock.mockReset();
    rpcMock.mockReset();
    storageFromMock.mockReset();
    uploadMock.mockReset();
    eqCallMock.mockReset();

    rpcMock.mockResolvedValue({ error: null });
    uploadMock.mockResolvedValue({ error: null });
    storageFromMock.mockReturnValue({ upload: uploadMock });
  });

  it('shows checklist for a return workflow task', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [
          { asset_id: 'asset-1', name: 'Excavator 300', status: 'on_rent', category_id: 'cat-excavator' },
        ],
        rental_current_asset_categories: [
          { entity_id: 'cat-excavator', name: 'Excavators' },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText('Inspection checklist')).toBeInTheDocument();
    });
    expect(screen.getByText(/Return checklist — Excavators/)).toBeInTheDocument();
    expect(screen.getByText('Engine oil level within range')).toBeInTheDocument();
  });

  it('shows checklist for a standalone inspection workflow task', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: '2026-06-07T09:00:00.000Z',
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [
          { asset_id: 'asset-1', name: 'Forklift 12', status: 'returned', category_id: 'cat-forklift' },
        ],
        rental_current_asset_categories: [
          { entity_id: 'cat-forklift', name: 'Forklifts' },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText('Inspection checklist')).toBeInTheDocument();
    });
    expect(screen.getByText('Fork blades straight with no visible cracks')).toBeInTheDocument();
  });

  it('shows a default checklist when category is not resolved', async () => {
    mockSupabaseTables(defaultTableData({
      v_rental_contract_line_current: [
        {
          entity_id: 'line-1',
          status: 'checked_out',
          contract_id: 'contract-1',
          asset_id: 'asset-1',
          actual_start: '2026-06-05T09:00:00.000Z',
          actual_end: null,
          data: { field_operator_id: TEST_OPERATOR_ID },
        },
      ],
      v_current_assets: [{ asset_id: 'asset-1', name: 'Unknown Machine', status: 'on_rent' }],
    }));

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText('Inspection checklist')).toBeInTheDocument();
    });
    expect(screen.getByText('General condition acceptable')).toBeInTheDocument();
  });

  it('includes checklist results in the inspection submission payload', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [
          { asset_id: 'asset-1', name: 'Excavator 300', status: 'on_rent', category_id: 'cat-ex' },
        ],
        rental_current_asset_categories: [
          { entity_id: 'cat-ex', name: 'Excavators' },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText('Inspection checklist')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('engine_oil pass'));
    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Signature');
    await userEvent.click(screen.getByRole('button', { name: 'Complete return' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        expect.stringMatching(/create_entity_with_version|rental_upsert_entity_current_state/),
        expect.objectContaining({
          p_data: expect.objectContaining({
            field_evidence: expect.objectContaining({
              checklist_items: expect.arrayContaining([
                expect.objectContaining({ key: 'engine_oil', status: 'pass' }),
              ]),
            }),
          }),
        })
      );
    });
  });

  it('restores category-specific checklist answers after reopening and reloading the same task', async () => {
    const tableData = {
      v_rental_contract_line_current: [
        {
          entity_id: 'line-1',
          status: 'checked_out',
          contract_id: 'contract-1',
          asset_id: 'asset-1',
          actual_start: '2026-06-05T09:00:00.000Z',
          actual_end: null,
          data: { field_operator_id: TEST_OPERATOR_ID },
        },
        {
          entity_id: 'line-2',
          status: 'checked_out',
          contract_id: 'contract-2',
          asset_id: 'asset-2',
          actual_start: '2026-06-05T09:00:00.000Z',
          actual_end: null,
          data: { field_operator_id: TEST_OPERATOR_ID },
        },
      ],
      v_current_assets: [
        { asset_id: 'asset-1', name: 'Excavator 300', status: 'on_rent', category_id: 'cat-ex' },
        { asset_id: 'asset-2', name: 'Forklift 12', status: 'on_rent', category_id: 'cat-fork' },
      ],
      rental_current_asset_categories: [
        { entity_id: 'cat-ex', name: 'Excavators' },
        { entity_id: 'cat-fork', name: 'Forklifts' },
      ],
      v_rental_contract_current: [
        { entity_id: 'contract-1', status: 'active', contract_number: 'RC-1001', data: { order_id: 'order-1' } },
        { entity_id: 'contract-2', status: 'active', contract_number: 'RC-1002', data: { order_id: 'order-2' } },
      ],
      v_rental_order_current: [
        { entity_id: 'order-1', status: 'active', data: { customer_id: 'cust-1', job_site_id: 'site-1' } },
        { entity_id: 'order-2', status: 'active', data: { customer_id: 'cust-2', job_site_id: 'site-2' } },
      ],
      rental_current_customers: [
        { entity_id: 'cust-1', name: 'Acme Construction' },
        { entity_id: 'cust-2', name: 'Harbor Logistics' },
      ],
      rental_current_job_sites: [
        { entity_id: 'site-1', name: 'Riverfront Jobsite' },
        { entity_id: 'site-2', name: 'Warehouse Yard' },
      ],
    };
    mockSupabaseTables(tableData);

    const note = 'Hydraulic seep at hose connection';
    const { unmount } = render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText(/Return checklist — Excavators/)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('engine_oil fail'));
    await userEvent.type(screen.getByLabelText('Note for engine_oil'), note);
    await userEvent.click(screen.getByRole('button', { name: /Pickup \/ Return[\s\S]*Forklift 12/i }));

    await waitFor(() => {
      expect(screen.getByText('Fork blades straight with no visible cracks')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /Pickup \/ Return[\s\S]*Excavator 300/i }));

    await waitFor(() => {
      expect(screen.getByText(/Return checklist — Excavators/)).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Note for engine_oil')).toHaveValue(note);

    unmount();
    mockSupabaseTables(tableData);
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText(/Return checklist — Excavators/)).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Note for engine_oil')).toHaveValue(note);
  });

  it('loads tenant checklist extensions and overrides from v_checklist_template_items', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [
          { asset_id: 'asset-1', name: 'Excavator 300', status: 'on_rent', category_id: 'cat-ex' },
        ],
        rental_current_asset_categories: [
          { entity_id: 'cat-ex', name: 'Excavators' },
        ],
        v_checklist_template_items: [
          {
            tenant_id: 'tenant-1',
            equipment_category: 'Excavators',
            inspection_intent: 'return',
            item_key: 'engine_oil',
            label: 'Tenant override - engine oil',
            section: 'Fluid Levels',
            is_required: true,
            sort_order: 10,
          },
          {
            tenant_id: 'tenant-1',
            equipment_category: 'Excavators',
            inspection_intent: 'return',
            item_key: 'custom_tenant_check',
            label: 'Tenant-specific attachment secured',
            section: 'Custom',
            is_required: false,
            sort_order: 20,
          },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(fromMock).toHaveBeenCalledWith('v_checklist_template_items');
      expect(screen.getByText('Tenant override - engine oil')).toBeInTheDocument();
    });
    expect(screen.getByText('Tenant-specific attachment secured')).toBeInTheDocument();
    expect(screen.queryByText('Engine oil level within range')).not.toBeInTheDocument();
  });

  it('shows pending-items warning when required checklist items are not completed', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          {
            entity_id: 'line-1',
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [
          { asset_id: 'asset-1', name: 'Excavator 300', status: 'on_rent', category_id: 'cat-ex' },
        ],
        rental_current_asset_categories: [
          { entity_id: 'cat-ex', name: 'Excavators' },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(
        screen.getByText(/items marked with an asterisk.*are required.*mark each pass, fail, or n\/a before submitting/i)
      ).toBeInTheDocument();
    });
  });
});

describe('resolveReturnScanCandidates', () => {
  beforeEach(() => {
    fromMock.mockReset();
    eqCallMock.mockReset();
    // Provide a default mock so the serial-number fallback path doesn't throw.
    mockSupabaseTables({ v_current_assets: [] });
  });

  const ASSET_UUID = '00000000-0000-4000-8000-000000000001';

  const makeReturnTask = (overrides: Partial<FieldTask> = {}): FieldTask => ({
    id: 'return:line-1',
    workflow: 'return',
    contractLineId: 'line-1',
    assetId: ASSET_UUID,
    contractId: 'contract-1',
    contractLabel: 'RC-1001',
    assetName: 'Excavator 300',
    assetCategoryName: 'Excavators',
    customerName: 'Acme Construction',
    jobSiteName: 'Riverfront Jobsite',
    timeLabel: 'Pickup date not scheduled',
    assetStatus: 'on_rent',
    contractStatus: 'active',
    inspectionType: 'return',
    downtimeMinutes: 0,
    assignmentData: {},
    projectContextId: '',
    costCode: '',
    lineData: {},
    assetState: {},
    ...overrides,
  });

  it('resolves a UUID scan directly to matching return tasks', async () => {
    const tasks = [makeReturnTask()];
    const { candidates, resolvedAssetId } = await resolveReturnScanCandidates(ASSET_UUID, tasks);
    expect(resolvedAssetId).toBe(ASSET_UUID);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].contractLineId).toBe('line-1');
  });

  it('resolves a UUID embedded in a longer scan string', async () => {
    const { candidates, resolvedAssetId } = await resolveReturnScanCandidates(
      'https://app.example.com/assets/00000000-0000-4000-8000-000000000099',
      [makeReturnTask({ assetId: '00000000-0000-4000-8000-000000000099' })]
    );
    expect(resolvedAssetId).toBe('00000000-0000-4000-8000-000000000099');
    expect(candidates).toHaveLength(1);
  });

  it('falls back to serial-number lookup when scan is not a UUID', async () => {
    mockSupabaseTables({
      v_current_assets: [{ asset_id: 'asset-1', serial_number: 'TXR-42001' }],
    });
    const tasks = [makeReturnTask({ assetId: 'asset-1' })];
    const { candidates, resolvedAssetId } = await resolveReturnScanCandidates('TXR-42001', tasks);
    expect(eqCallMock).toHaveBeenCalledWith('v_current_assets', 'serial_number', 'TXR-42001');
    expect(resolvedAssetId).toBe('asset-1');
    expect(candidates).toHaveLength(1);
  });

  it('returns empty candidates when serial number is not found', async () => {
    mockSupabaseTables({ v_current_assets: [] });
    const tasks = [makeReturnTask()];
    const { candidates, resolvedAssetId } = await resolveReturnScanCandidates('UNKNOWN-SN', tasks);
    expect(resolvedAssetId).toBe('');
    expect(candidates).toHaveLength(0);
  });

  it('returns empty candidates when scan value is blank', async () => {
    const tasks = [makeReturnTask()];
    const { candidates, resolvedAssetId } = await resolveReturnScanCandidates('   ', tasks);
    expect(resolvedAssetId).toBe('');
    expect(candidates).toHaveLength(0);
  });

  it('returns multiple candidates when asset appears in more than one return task', async () => {
    const tasks = [
      makeReturnTask({ id: 'return:line-1', contractLineId: 'line-1', contractId: 'contract-1' }),
      makeReturnTask({ id: 'return:line-2', contractLineId: 'line-2', contractId: 'contract-2' }),
    ];
    const { candidates } = await resolveReturnScanCandidates(ASSET_UUID, tasks);
    expect(candidates).toHaveLength(2);
  });
});

describe('resolveQuickOrderTask', () => {
  beforeEach(() => {
    fromMock.mockReset();
    eqCallMock.mockReset();
    mockSupabaseTables({ v_current_assets: [] });
  });

  const makeCheckoutTask = (overrides: Partial<FieldTask> = {}): FieldTask => ({
    id: 'checkout:line-1',
    workflow: 'checkout',
    contractLineId: 'line-1',
    assetId: '00000000-0000-4000-8000-000000000001',
    contractId: 'contract-1',
    contractLabel: 'RC-1001',
    assetName: 'Excavator 300',
    assetCategoryName: 'Excavators',
    customerName: 'Acme Construction',
    jobSiteName: 'Riverfront Jobsite',
    timeLabel: 'Checkout date not scheduled',
    assetStatus: 'available',
    contractStatus: 'active',
    inspectionType: 'checkout',
    downtimeMinutes: 0,
    assignmentData: {},
    projectContextId: '',
    costCode: '',
    lineData: {},
    assetState: {},
    ...overrides,
  });

  it('resolves a UUID scan directly to a checkout task', async () => {
    const task = makeCheckoutTask();
    await expect(resolveQuickOrderTask(task.assetId, [task])).resolves.toBe(task);
  });

  it('ignores non-checkout tasks when resolving', async () => {
    const task = makeCheckoutTask({ workflow: 'return' });
    await expect(resolveQuickOrderTask(task.assetId, [task])).resolves.toBeNull();
  });

  it('returns ambiguous when text matches multiple checkout tasks', async () => {
    const tasks = [
      makeCheckoutTask({ id: 'checkout:line-1', assetId: 'asset-1', assetName: 'Excavator 300' }),
      makeCheckoutTask({ id: 'checkout:line-2', contractLineId: 'line-2', assetId: 'asset-2', contractId: 'contract-2', contractLabel: 'RC-1002', assetName: 'Excavator 450' }),
    ];
    await expect(resolveQuickOrderTask('excavator', tasks)).resolves.toBe('ambiguous');
  });

  it('falls back to serial-number lookup when text does not resolve uniquely', async () => {
    mockSupabaseTables({
      v_current_assets: [{ asset_id: 'asset-serial-1', serial_number: 'TXR-42001' }],
    });
    const task = makeCheckoutTask({ assetId: 'asset-serial-1' });
    const resolved = await resolveQuickOrderTask('TXR-42001', [task]);
    expect(eqCallMock).toHaveBeenCalledWith('v_current_assets', 'serial_number', 'TXR-42001');
    expect(resolved).toBe(task);
  });
});

describe('selectReturnCandidateWithContext', () => {
  const makeTask = (id: string, contractId: string, customerName = 'Acme', jobSiteName = 'Site A'): FieldTask => ({
    id,
    workflow: 'return',
    contractLineId: id,
    assetId: 'asset-1',
    contractId,
    contractLabel: contractId,
    assetName: 'Excavator 300',
    assetCategoryName: 'Excavators',
    customerName,
    jobSiteName,
    timeLabel: '',
    assetStatus: 'on_rent',
    contractStatus: 'active',
    inspectionType: 'return',
    downtimeMinutes: 0,
    assignmentData: {},
    projectContextId: '',
    costCode: '',
    lineData: {},
    assetState: {},
  });

  it('returns the single task with isContextMatch=true when no session context', () => {
    const result = selectReturnCandidateWithContext([makeTask('return:l1', 'c1')], null);
    expect(result.task?.id).toBe('return:l1');
    expect(result.isContextMatch).toBe(true);
    expect(result.requiresDisambiguation).toBe(false);
  });

  it('returns isContextMatch=false when single task does not match session context', () => {
    const context: ReturnSessionContext = { contractId: 'c2', customerName: 'Harbor', jobSiteName: 'Yard' };
    const result = selectReturnCandidateWithContext([makeTask('return:l1', 'c1')], context);
    expect(result.task?.id).toBe('return:l1');
    expect(result.isContextMatch).toBe(false);
    expect(result.requiresDisambiguation).toBe(false);
  });

  it('auto-selects from multiple candidates using session context', () => {
    const context: ReturnSessionContext = { contractId: 'c1', customerName: 'Acme', jobSiteName: 'Site A' };
    const candidates = [makeTask('return:l1', 'c1'), makeTask('return:l2', 'c2')];
    const result = selectReturnCandidateWithContext(candidates, context);
    expect(result.task?.id).toBe('return:l1');
    expect(result.isContextMatch).toBe(true);
    expect(result.requiresDisambiguation).toBe(false);
  });

  it('requires disambiguation when multiple candidates and no session context', () => {
    const candidates = [makeTask('return:l1', 'c1'), makeTask('return:l2', 'c2')];
    const result = selectReturnCandidateWithContext(candidates, null);
    expect(result.task).toBeNull();
    expect(result.requiresDisambiguation).toBe(true);
  });

  it('requires disambiguation when multiple candidates all match session context', () => {
    const context: ReturnSessionContext = { contractId: 'c1', customerName: 'Acme', jobSiteName: 'Site A' };
    const candidates = [makeTask('return:l1', 'c1'), makeTask('return:l2', 'c1')];
    const result = selectReturnCandidateWithContext(candidates, context);
    expect(result.task).toBeNull();
    expect(result.requiresDisambiguation).toBe(true);
  });

  it('returns empty result for empty candidates', () => {
    const result = selectReturnCandidateWithContext([], null);
    expect(result.task).toBeNull();
    expect(result.requiresDisambiguation).toBe(false);
  });
});

describe('Quick Return UI', () => {
  const returnLineData = {
    entity_id: 'line-1',
    status: 'checked_out',
    contract_id: 'contract-1',
    asset_id: 'asset-1',
    actual_start: '2026-06-05T09:00:00.000Z',
    actual_end: null,
    data: { field_operator_id: TEST_OPERATOR_ID },
  };

  beforeEach(() => {
    window.sessionStorage.clear();
    authState.profile = { id: TEST_OPERATOR_ID, role: 'field_operator' };
    fromMock.mockReset();
    rpcMock.mockReset();
    storageFromMock.mockReset();
    uploadMock.mockReset();
    eqCallMock.mockReset();

    rpcMock.mockResolvedValue({ error: null });
    uploadMock.mockResolvedValue({ error: null });
    storageFromMock.mockReturnValue({ upload: uploadMock });

    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [returnLineData],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', serial_number: 'TXR-42001', status: 'on_rent' }],
      })
    );
  });

  describe('Quick checkout UI', () => {
    beforeEach(() => {
      window.sessionStorage.clear();
      authState.profile = { id: TEST_OPERATOR_ID, role: 'field_operator' };
      fromMock.mockReset();
      rpcMock.mockReset();
      storageFromMock.mockReset();
      uploadMock.mockReset();
      eqCallMock.mockReset();

      rpcMock.mockResolvedValue({ error: null });
      uploadMock.mockResolvedValue({ error: null });
      storageFromMock.mockReturnValue({ upload: uploadMock });

      mockSupabaseTables(defaultTableData());
    });

    it('renders the Quick checkout card at the top of the field screen', async () => {
      render(<MobileFieldWorkflowScreen />);

      await waitFor(() => {
        expect(screen.getByText('Quick checkout')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Scan or enter asset identifier')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Find task' })).toBeInTheDocument();
    });

    it('shows a resolved task panel when quick checkout finds a unique checkout task', async () => {
      render(<MobileFieldWorkflowScreen />);

      await waitFor(() => {
        expect(screen.getByLabelText('Scan or enter asset identifier')).toBeInTheDocument();
      });

      await userEvent.type(screen.getByLabelText('Scan or enter asset identifier'), 'Excavator');
      await userEvent.click(screen.getByRole('button', { name: 'Find task' }));

      await waitFor(() => {
        expect(screen.getByTestId('quick-order-panel')).toBeInTheDocument();
      });

      const panel = screen.getByTestId('quick-order-panel');
      expect(panel).toHaveTextContent('Excavator 300');
      expect(panel).toHaveTextContent('Acme Construction');
      expect(panel).toHaveTextContent('RC-1001');
    });

    it('shows a refine-input message and no resolved panel when quick checkout input is ambiguous', async () => {
      mockSupabaseTables(
        defaultTableData({
          v_rental_contract_line_current: [
            {
              entity_id: 'line-1',
              status: 'pending',
              contract_id: 'contract-1',
              asset_id: 'asset-1',
              actual_start: null,
              actual_end: null,
              data: { planned_start: '2026-06-07T09:00:00.000Z', field_operator_id: TEST_OPERATOR_ID },
            },
            {
              entity_id: 'line-2',
              status: 'pending',
              contract_id: 'contract-2',
              asset_id: 'asset-2',
              actual_start: null,
              actual_end: null,
              data: { planned_start: '2026-06-07T09:00:00.000Z', field_operator_id: TEST_OPERATOR_ID },
            },
          ],
          v_current_assets: [
            { asset_id: 'asset-1', name: 'Excavator 300', serial_number: 'TXR-42001', status: 'available' },
            { asset_id: 'asset-2', name: 'Excavator 450', serial_number: 'TXR-42002', status: 'available' },
          ],
          v_rental_contract_current: [
            { entity_id: 'contract-1', status: 'active', contract_number: 'RC-1001', data: { order_id: 'order-1' } },
            { entity_id: 'contract-2', status: 'active', contract_number: 'RC-1002', data: { order_id: 'order-1' } },
          ],
        })
      );

      render(<MobileFieldWorkflowScreen />);

      await waitFor(() => {
        expect(screen.getByLabelText('Scan or enter asset identifier')).toBeInTheDocument();
      });

      await userEvent.type(screen.getByLabelText('Scan or enter asset identifier'), 'excavator');
      await userEvent.click(screen.getByRole('button', { name: 'Find task' }));

      await waitFor(() => {
        expect(
          screen.getByText('Multiple checkout tasks match this input. Enter a more specific value to identify the asset.')
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId('quick-order-panel')).not.toBeInTheDocument();
      expect(rpcMock).not.toHaveBeenCalled();
    });

    it('submits quick checkout through the existing RPC boundary', async () => {
      render(<MobileFieldWorkflowScreen />);

      await waitFor(() => {
        expect(screen.getByLabelText('Scan or enter asset identifier')).toBeInTheDocument();
      });

      await userEvent.type(screen.getByLabelText('Scan or enter asset identifier'), 'Excavator');
      await userEvent.click(screen.getByRole('button', { name: 'Find task' }));

      await waitFor(() => {
        expect(screen.getByTestId('quick-order-panel')).toBeInTheDocument();
      });

      const panel = screen.getByTestId('quick-order-panel');
      await userEvent.type(within(panel).getByLabelText('Assigned driver'), 'Sam Driver');
      await userEvent.type(within(panel).getByLabelText('Assigned truck'), 'Truck-42');
      await userEvent.type(within(panel).getByLabelText('Departure timestamp'), '2026-06-09T08:00');
      await userEvent.type(within(panel).getByLabelText('Driver signature'), 'Sam Driver');
      await userEvent.type(within(panel).getByLabelText('Customer/operator signature'), 'Operator Sig');

      await userEvent.click(screen.getByRole('button', { name: 'Quick checkout' }));

      await waitFor(() => {
        expect(rpcMock).toHaveBeenCalledWith(
          'rental_upsert_entity_current_state',
          expect.objectContaining({
            p_entity_type: 'rental_contract_line',
            p_entity_id: 'line-1',
            p_data: expect.objectContaining({
              status: 'checked_out',
              confirm_load: expect.objectContaining({
                assigned_driver: 'Sam Driver',
                assigned_truck: 'Truck-42',
                driver_signature: 'Sam Driver',
                departure_at: expect.any(String),
              }),
              field_evidence: expect.objectContaining({
                signature: 'Operator Sig',
                approval_event_type: 'delivery',
              }),
            }),
          })
        );
        expect(rpcMock).toHaveBeenCalledWith(
          'rental_upsert_entity_current_state',
          expect.objectContaining({
            p_entity_type: 'asset',
            p_entity_id: 'asset-1',
            p_data: expect.objectContaining({
              status: 'on_rent',
              last_field_workflow: 'checkout',
            }),
          })
        );
      });

      expect(screen.getByTestId('quick-checkout-status')).toHaveTextContent('Quick checkout completed for Excavator 300.');
      expect(screen.queryByTestId('quick-order-panel')).not.toBeInTheDocument();
    });
  });

  it('renders the Quick Return scan panel', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByText('Quick Return — Serialized scan')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Quick return scan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
  });

  it('shows error when scan input is empty', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    expect(screen.getByText('Enter a scan value or serial number to start a quick return.')).toBeInTheDocument();
  });

  it('shows error when no return task is found for the scan', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [returnLineData],
        v_current_assets: [{ asset_id: 'asset-1', serial_number: 'TXR-42001', status: 'on_rent' }],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Quick return scan'), 'UNKNOWN-BARCODE');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(
        screen.getByText('No return task found for this scan. Verify the asset is assigned to you and is checked out.')
      ).toBeInTheDocument();
    });
  });

  it('selects the return task when scan resolves to a unique candidate', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Quick return scan'), 'TXR-42001');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(eqCallMock).toHaveBeenCalledWith('v_current_assets', 'serial_number', 'TXR-42001');
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });
  });

  it('shows disambiguation list when multiple return candidates are found', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          returnLineData,
          {
            entity_id: 'line-2',
            status: 'checked_out',
            contract_id: 'contract-2',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', serial_number: 'TXR-42001', status: 'on_rent' }],
        v_rental_contract_current: [
          { entity_id: 'contract-1', status: 'active', contract_number: 'RC-1001', data: { order_id: 'order-1' } },
          { entity_id: 'contract-2', status: 'active', contract_number: 'RC-1002', data: { order_id: 'order-2' } },
        ],
        v_rental_order_current: [
          { entity_id: 'order-1', status: 'active', data: { customer_id: 'cust-1', job_site_id: 'site-1' } },
          { entity_id: 'order-2', status: 'active', data: { customer_id: 'cust-2', job_site_id: 'site-2' } },
        ],
        rental_current_customers: [
          { entity_id: 'cust-1', name: 'Acme Construction' },
          { entity_id: 'cust-2', name: 'Harbor Logistics' },
        ],
        rental_current_job_sites: [
          { entity_id: 'site-1', name: 'Riverfront Jobsite' },
          { entity_id: 'site-2', name: 'Warehouse Yard' },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Quick return scan'), 'TXR-42001');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(screen.getByText('Multiple return tasks found — select the correct contract line:')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /RC-1001/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /RC-1002/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start return' })).toBeDisabled();
  });

  it('enables Start return button after selecting a disambiguation candidate', async () => {
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          returnLineData,
          {
            entity_id: 'line-2',
            status: 'checked_out',
            contract_id: 'contract-2',
            asset_id: 'asset-1',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [{ asset_id: 'asset-1', name: 'Excavator 300', serial_number: 'TXR-42001', status: 'on_rent' }],
        v_rental_contract_current: [
          { entity_id: 'contract-1', status: 'active', contract_number: 'RC-1001', data: { order_id: 'order-1' } },
          { entity_id: 'contract-2', status: 'active', contract_number: 'RC-1002', data: { order_id: 'order-1' } },
        ],
        v_rental_order_current: [
          { entity_id: 'order-1', status: 'active', data: { customer_id: 'cust-1', job_site_id: 'site-1' } },
        ],
        rental_current_customers: [{ entity_id: 'cust-1', name: 'Acme Construction' }],
        rental_current_job_sites: [{ entity_id: 'site-1', name: 'Riverfront Jobsite' }],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Quick return scan'), 'TXR-42001');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(screen.getByText('Multiple return tasks found — select the correct contract line:')).toBeInTheDocument();
    });

    // Select RC-1001 candidate
    const candidateButtons = screen.getAllByRole('button', { name: /RC-1001/ });
    await userEvent.click(candidateButtons[0]);

    expect(screen.getByRole('button', { name: 'Start return' })).not.toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Start return' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });
  });

  it('shows context-conflict alert when scan resolves outside session context', async () => {
    // Both return tasks loaded upfront — different contracts and customers.
    mockSupabaseTables(
      defaultTableData({
        v_rental_contract_line_current: [
          returnLineData,
          {
            entity_id: 'line-2',
            status: 'checked_out',
            contract_id: 'contract-2',
            asset_id: 'asset-2',
            actual_start: '2026-06-05T09:00:00.000Z',
            actual_end: null,
            data: { field_operator_id: TEST_OPERATOR_ID },
          },
        ],
        v_current_assets: [
          { asset_id: 'asset-1', name: 'Excavator 300', serial_number: 'TXR-42001', status: 'on_rent' },
          { asset_id: 'asset-2', name: 'Forklift 12', serial_number: 'FLT-99', status: 'on_rent' },
        ],
        v_rental_contract_current: [
          { entity_id: 'contract-1', status: 'active', contract_number: 'RC-1001', data: { order_id: 'order-1' } },
          { entity_id: 'contract-2', status: 'active', contract_number: 'RC-1002', data: { order_id: 'order-2' } },
        ],
        v_rental_order_current: [
          { entity_id: 'order-1', status: 'active', data: { customer_id: 'cust-1', job_site_id: 'site-1' } },
          { entity_id: 'order-2', status: 'active', data: { customer_id: 'cust-2', job_site_id: 'site-2' } },
        ],
        rental_current_customers: [
          { entity_id: 'cust-1', name: 'Acme Construction' },
          { entity_id: 'cust-2', name: 'Harbor Logistics' },
        ],
        rental_current_job_sites: [
          { entity_id: 'site-1', name: 'Riverfront Jobsite' },
          { entity_id: 'site-2', name: 'Warehouse Yard' },
        ],
      })
    );

    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    // Scan first asset (TXR-42001 / contract-1 / Acme) to establish session context.
    await userEvent.type(screen.getByLabelText('Quick return scan'), 'TXR-42001');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });
    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Sig A');
    await userEvent.click(screen.getByRole('button', { name: 'Complete return' }));
    await waitFor(() => {
      expect(screen.getByText(/Session context:/)).toBeInTheDocument();
    });

    // Scan second asset (FLT-99 / contract-2 / Harbor) — different context → conflict shown.
    await userEvent.type(screen.getByLabelText('Quick return scan'), 'FLT-99');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(screen.getByText('Different customer context')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Harbor Logistics/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Switch context' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('sets session context after completing a return and shows it in the Quick Return panel', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    // Resolve scan, select task, complete the return
    await userEvent.type(screen.getByLabelText('Quick return scan'), 'TXR-42001');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Sig');
    await userEvent.click(screen.getByRole('button', { name: 'Complete return' }));

    await waitFor(() => {
      expect(screen.getByText(/Session context:/)).toBeInTheDocument();
    });
    // The session banner includes the customer and job site names.
    expect(screen.getByText(/Session context:/).parentElement?.textContent).toMatch(/Acme Construction/);
  });

  it('clears session context when the Clear button is clicked', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Quick return scan'), 'TXR-42001');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Sig');
    await userEvent.click(screen.getByRole('button', { name: 'Complete return' }));

    await waitFor(() => {
      expect(screen.getByText(/Session context:/)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.queryByText(/Session context:/)).not.toBeInTheDocument();
  });

  it('clears session context after the final return task is completed and tasks becomes empty', async () => {
    render(<MobileFieldWorkflowScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Quick return scan'), 'TXR-42001');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete return' })).toBeInTheDocument();
    });

    // Simulate no tasks remaining after the return is processed.
    mockSupabaseTables(defaultTableData({ v_rental_contract_line_current: [] }));

    await userEvent.type(screen.getByLabelText('Customer/operator signature'), 'Operator Sig');
    await userEvent.click(screen.getByRole('button', { name: 'Complete return' }));

    // Session context banner must not persist once all return tasks are gone.
    await waitFor(() => {
      expect(screen.queryByText(/Session context:/)).not.toBeInTheDocument();
    });
  });
});
