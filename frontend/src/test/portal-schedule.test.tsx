import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

const { fromMock, rpcMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
    rpc: rpcMock,
  },
}));

// TanStack Router params must be provided via the screen props in tests; we
// don't need the real router here.
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    // createFileRoute('/some/path')({ component: Comp }) — return a stub that is
    // callable (outer) and whose return value is also callable (inner) so the
    // module-level `export const Route = createFileRoute(...)({...})` doesn't throw.
    createFileRoute: () => () => ({}),
  };
});

import {
  PortalScheduleScreen,
  formatDateLabel,
} from '@/routes/portal/schedule/$contractId';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'contract-abc';
const CONTRACT_UUID = '123e4567-e89b-42d3-a456-426614174000';
const ASSET_ID_1 = 'asset-001';
const ASSET_ID_2 = 'asset-002';
const ASSET_UUID = '550e8400-e29b-41d4-a716-446655440000';
const LINE_ID_1 = 'line-001';
const LINE_ID_2 = 'line-002';

/**
 * Returns the flat row shape produced by the portal_get_contract_schedule RPC.
 * Each row combines contract + one line + its asset data.
 */
function defaultScheduleRows(): Record<string, unknown>[] {
  return [
    {
      contract_entity_id: CONTRACT_ID,
      contract_status: 'active',
      contract_number: 'RC-9001',
      line_entity_id: LINE_ID_1,
      line_status: 'pending',
      line_contract_id: CONTRACT_ID,
      line_asset_id: ASSET_ID_1,
      line_actual_start: null,
      line_actual_end: null,
      line_data: { planned_start: '2026-07-01T08:00:00.000Z', planned_end: '2026-07-15T17:00:00.000Z' },
      asset_name: 'Excavator XL',
      asset_status: 'available',
    },
    {
      contract_entity_id: CONTRACT_ID,
      contract_status: 'active',
      contract_number: 'RC-9001',
      line_entity_id: LINE_ID_2,
      line_status: 'checked_out',
      line_contract_id: CONTRACT_ID,
      line_asset_id: ASSET_ID_2,
      line_actual_start: '2026-06-20T08:00:00.000Z',
      line_actual_end: null,
      line_data: { planned_end: '2026-07-20T17:00:00.000Z' },
      asset_name: 'Forklift 5T',
      asset_status: 'on_rent',
    },
  ];
}

/**
 * Sets up rpcMock to serve portal_get_contract_schedule with the given rows,
 * and keeps the default behaviour for portal_submit_customer_service_request and
 * portal_list_customer_service_requests.
 */
function mockScheduleRpc(rows: Record<string, unknown>[]) {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'portal_get_contract_schedule') {
      return Promise.resolve({ data: rows, error: null });
    }
    if (fn === 'portal_submit_customer_service_request') {
      return Promise.resolve({ data: [{ request_id: 'off-rent-request-1' }], error: null });
    }
    if (fn === 'portal_list_customer_service_requests') {
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PortalScheduleScreen', () => {
  beforeEach(() => {
    fromMock.mockReset();
    rpcMock.mockReset();
    mockScheduleRpc(defaultScheduleRows());
  });

  it('renders the portal page container', async () => {
    render(<PortalScheduleScreen contractId={CONTRACT_ID} pageUrl="http://example.com/portal/schedule/contract-abc" />);
    await waitFor(() => {
      expect(screen.getByTestId('portal-schedule-page')).toBeInTheDocument();
    });
  });

  it('shows a loading indicator while data is being fetched', () => {
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
  });

  it('shows contract label once loaded', async () => {
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('contract-label')).toHaveTextContent('RC-9001');
    });
  });

  it('renders a schedule entry for each contract line', async () => {
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId(`schedule-entry-${LINE_ID_1}`)).toBeInTheDocument();
      expect(screen.getByTestId(`schedule-entry-${LINE_ID_2}`)).toBeInTheDocument();
    });
  });

  it('shows asset names in schedule entries', async () => {
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByText('Excavator XL')).toBeInTheDocument();
      expect(screen.getByText('Forklift 5T')).toBeInTheDocument();
    });
  });

  it('shows "Delivery Scheduled" badge for pending lines', async () => {
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByText('Delivery Scheduled')).toBeInTheDocument();
    });
  });

  it('shows "On Rent · Pickup Scheduled" badge for checked-out lines', async () => {
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/On Rent/i)).toBeInTheDocument();
    });
  });

  it('renders incoming/current/scheduled-for-pickup status labels', async () => {
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId(`site-status-${LINE_ID_1}`)).toHaveTextContent('Incoming');
      expect(screen.getByTestId(`site-status-${LINE_ID_2}`)).toHaveTextContent('Current');
      expect(screen.getByTestId(`pickup-status-${LINE_ID_2}`)).toHaveTextContent('Scheduled for Pickup');
    });
  });

  it('shows empty state when there are no lines', async () => {
    mockScheduleRpc([]);
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
  });

  it('shows an error alert when data loading fails', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'portal_get_contract_schedule') {
        return Promise.resolve({ data: null, error: { message: 'DB connection failed' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('load-error')).toBeInTheDocument();
    });
  });

  it('shows an explicit load error for invalid scope token even when schedule rows are empty', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'portal_get_contract_schedule') {
        return Promise.resolve({ data: [], error: null });
      }
      if (fn === 'portal_list_customer_service_requests') {
        return Promise.resolve({ data: null, error: { message: 'Portal scope token is invalid for this contract' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<PortalScheduleScreen contractId={CONTRACT_ID} pageUrl="http://example.com/portal/schedule/contract-abc?scope=forged-token" />);
    await waitFor(() => {
      expect(screen.getByTestId('load-error')).toBeInTheDocument();
      expect(screen.getByText(/scope token is invalid/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('renders a copy link button', async () => {
    render(
      <PortalScheduleScreen
        contractId={CONTRACT_ID}
        pageUrl="http://example.com/portal/schedule/contract-abc"
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('copy-link-button')).toBeInTheDocument();
    });
  });

  it('shows "Returned" badge for returned lines', async () => {
    mockScheduleRpc([
      {
        contract_entity_id: CONTRACT_ID,
        contract_status: 'active',
        contract_number: 'RC-9001',
        line_entity_id: LINE_ID_1,
        line_status: 'returned',
        line_contract_id: CONTRACT_ID,
        line_asset_id: ASSET_ID_1,
        line_actual_start: '2026-06-10T08:00:00.000Z',
        line_actual_end: '2026-06-25T17:00:00.000Z',
        line_data: {},
        asset_name: 'Excavator XL',
        asset_status: 'available',
      },
    ]);
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId(`site-status-${LINE_ID_1}`)).toHaveTextContent('Returned');
    });
  });

  it('shows copy confirmation text after clicking the copy button', async () => {
    const user = userEvent.setup();

    // Provide clipboard mock
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    render(
      <PortalScheduleScreen
        contractId={CONTRACT_ID}
        pageUrl="http://example.com/portal/schedule/contract-abc"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('copy-link-button')).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByTestId('copy-link-button'));
    });

    expect(screen.getByText(/Copied!/i)).toBeInTheDocument();
  });

  it('humanizes UUID fallback labels for contract and asset names', async () => {
    mockScheduleRpc([
      {
        contract_entity_id: CONTRACT_UUID,
        contract_status: 'active',
        contract_number: null,
        line_entity_id: LINE_ID_1,
        line_status: 'pending',
        line_contract_id: CONTRACT_UUID,
        line_asset_id: ASSET_UUID,
        line_actual_start: null,
        line_actual_end: null,
        line_data: { planned_start: '2026-07-01T08:00:00.000Z' },
        asset_name: null,
        asset_status: null,
      },
    ]);

    render(<PortalScheduleScreen contractId={CONTRACT_UUID} />);

    await waitFor(() => {
      expect(screen.getByTestId('contract-label')).toHaveTextContent('Contract 123E4567');
      expect(screen.getByTestId(`schedule-entry-${LINE_ID_1}`)).toHaveTextContent('Asset 550E8400');
    });
  });

  it('creates a pickup request from a checked-out line and surfaces queue confirmation', async () => {
    const user = userEvent.setup();
    render(<PortalScheduleScreen contractId={CONTRACT_ID} pageUrl="http://example.com/portal/schedule/contract-abc?scope=valid-scope-token" />);

    await waitFor(() => {
      expect(screen.getByTestId(`customer-request-${LINE_ID_2}-off_rent_pickup`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`customer-request-${LINE_ID_2}-off_rent_pickup`));
    await user.click(screen.getByTestId(`submit-customer-request-${LINE_ID_2}`));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('portal_submit_customer_service_request', expect.objectContaining({
        p_contract_id: CONTRACT_ID,
        p_contract_line_id: LINE_ID_2,
        p_scope_token: 'valid-scope-token',
        p_request_type: 'off_rent_pickup',
      }));
      expect(screen.getByTestId('customer-request-success')).toBeInTheDocument();
      expect(screen.getByTestId(`customer-requested-${LINE_ID_2}-off_rent_pickup`)).toBeInTheDocument();
    });
  });

  it('submits extension request with urgency and note', async () => {
    const user = userEvent.setup();
    render(<PortalScheduleScreen contractId={CONTRACT_ID} pageUrl="http://example.com/portal/schedule/contract-abc?scope=scope-token" />);

    await waitFor(() => {
      expect(screen.getByTestId(`customer-request-${LINE_ID_2}-contract_extension`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`customer-request-${LINE_ID_2}-contract_extension`));
    await user.selectOptions(screen.getByTestId(`request-type-${LINE_ID_2}`), 'contract_extension');
    await user.selectOptions(screen.getByTestId(`request-urgency-${LINE_ID_2}`), 'high');
    await user.type(screen.getByTestId(`request-note-${LINE_ID_2}`), 'Need +7 days due to weather delay');
    await user.click(screen.getByTestId(`request-photos-${LINE_ID_2}`));
    await user.click(screen.getByTestId(`submit-customer-request-${LINE_ID_2}`));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('portal_submit_customer_service_request', expect.objectContaining({
        p_request_type: 'contract_extension',
        p_urgency: 'high',
        p_customer_note: 'Need +7 days due to weather delay',
        p_has_supporting_photos: true,
      }));
      expect(screen.getByTestId(`customer-requested-${LINE_ID_2}-contract_extension`)).toBeInTheDocument();
    });
  });

  it('submits field service request and explicitly captures missing context', async () => {
    const user = userEvent.setup();
    render(<PortalScheduleScreen contractId={CONTRACT_ID} pageUrl="http://example.com/portal/schedule/contract-abc?scope=scope-token" />);

    await waitFor(() => {
      expect(screen.getByTestId(`customer-request-${LINE_ID_2}-field_service`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`customer-request-${LINE_ID_2}-field_service`));
    await user.selectOptions(screen.getByTestId(`request-type-${LINE_ID_2}`), 'field_service');
    await user.selectOptions(screen.getByTestId(`request-urgency-${LINE_ID_2}`), 'critical');
    await user.click(screen.getByTestId(`request-missing-context-${LINE_ID_2}`));
    await user.click(screen.getByTestId(`submit-customer-request-${LINE_ID_2}`));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('portal_submit_customer_service_request', expect.objectContaining({
        p_request_type: 'field_service',
        p_urgency: 'critical',
        p_missing_contract_context: true,
      }));
      expect(screen.getByTestId(`customer-requested-${LINE_ID_2}-field_service`)).toBeInTheDocument();
    });
  });

  it('shows an error alert when customer request creation fails', async () => {
    const user = userEvent.setup();
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'portal_get_contract_schedule') {
        return Promise.resolve({ data: defaultScheduleRows(), error: null });
      }
      if (fn === 'portal_list_customer_service_requests') {
        return Promise.resolve({ data: [], error: null });
      }
      if (fn === 'portal_submit_customer_service_request') {
        return Promise.resolve({ data: null, error: { message: 'rpc unavailable' } });
      }
      return Promise.resolve({ data: null, error: null });
    });
    render(<PortalScheduleScreen contractId={CONTRACT_ID} pageUrl="http://example.com/portal/schedule/contract-abc?scope=scope-token" />);

    await waitFor(() => {
      expect(screen.getByTestId(`customer-request-${LINE_ID_2}-off_rent_pickup`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`customer-request-${LINE_ID_2}-off_rent_pickup`));
    await user.click(screen.getByTestId(`submit-customer-request-${LINE_ID_2}`));

    await waitFor(() => {
      expect(screen.getByTestId('customer-request-error')).toBeInTheDocument();
      expect(screen.getByText('rpc unavailable')).toBeInTheDocument();
    });
  });

  it('rejects request submission when scope token is missing', async () => {
    const user = userEvent.setup();
    render(<PortalScheduleScreen contractId={CONTRACT_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId(`customer-request-${LINE_ID_2}-off_rent_pickup`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`customer-request-${LINE_ID_2}-off_rent_pickup`));
    await user.click(screen.getByTestId(`submit-customer-request-${LINE_ID_2}`));

    await waitFor(() => {
      expect(screen.getByTestId('customer-request-error')).toBeInTheDocument();
      expect(screen.getByText('Missing or invalid portal scope token.')).toBeInTheDocument();
    });
    expect(rpcMock).not.toHaveBeenCalledWith(
      'portal_submit_customer_service_request',
      expect.objectContaining({ p_contract_line_id: LINE_ID_2 })
    );
  });

  it('keeps queued off-rent badge visible when a line has a persisted request', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'portal_get_contract_schedule') {
        return Promise.resolve({
          data: [
            {
              contract_entity_id: CONTRACT_ID,
              contract_status: 'active',
              contract_number: 'RC-9001',
              line_entity_id: LINE_ID_2,
              line_status: 'returned',
              line_contract_id: CONTRACT_ID,
              line_asset_id: ASSET_ID_2,
              line_actual_start: '2026-06-20T08:00:00.000Z',
              line_actual_end: '2026-06-25T17:00:00.000Z',
              line_data: { planned_end: '2026-07-20T17:00:00.000Z' },
              asset_name: 'Forklift 5T',
              asset_status: 'available',
            },
          ],
          error: null,
        });
      }
      if (fn === 'portal_list_customer_service_requests') {
        return Promise.resolve({
          data: [
            {
              request_id: 'off-rent-request-1',
              contract_id: CONTRACT_ID,
              contract_line_id: LINE_ID_2,
              asset_id: ASSET_ID_2,
              job_site_id: null,
              request_type: 'off_rent_pickup',
              status: 'requested',
              urgency: 'standard',
              reason: 'Flagged idle by site user from portal schedule',
              customer_note: null,
              has_supporting_photos: false,
              missing_contract_context: false,
              evidence_gaps: ['supporting_photos_missing'],
              recommended_disposition: 'Review pickup/call-off readiness with contract line context, then schedule manually after branch approval.',
              requires_human_approval: true,
              requested_at: '2026-06-21T10:00:00.000Z',
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<PortalScheduleScreen contractId={CONTRACT_ID} pageUrl="http://example.com/portal/schedule/contract-abc?scope=scope-token" />);
    await waitFor(() => {
      expect(screen.getByTestId(`customer-requested-${LINE_ID_2}-off_rent_pickup`)).toBeInTheDocument();
    });
    expect(screen.queryByTestId(`customer-request-${LINE_ID_2}-off_rent_pickup`)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for pure helper functions
// ---------------------------------------------------------------------------

describe('formatDateLabel', () => {
  it('returns the fallback for null input', () => {
    expect(formatDateLabel(null)).toBe('Not scheduled');
  });

  it('returns the fallback for undefined input', () => {
    expect(formatDateLabel(undefined)).toBe('Not scheduled');
  });

  it('returns the fallback for an invalid date string', () => {
    expect(formatDateLabel('not-a-date')).toBe('Not scheduled');
  });

  it('formats a valid ISO date string', () => {
    const result = formatDateLabel('2026-07-01T08:00:00.000Z');
    // The exact locale format varies, but the year must be present
    expect(result).toMatch(/2026/);
  });

  it('uses a custom fallback when provided', () => {
    expect(formatDateLabel(null, 'TBD')).toBe('TBD');
  });
});
