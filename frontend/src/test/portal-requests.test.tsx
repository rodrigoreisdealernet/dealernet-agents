/**
 * Tests for the portal authenticated service request screen (/portal/requests).
 *
 * Coverage:
 *   - Unauthenticated state shows sign-in form
 *   - Authenticated portal_customer state loads rentals
 *   - Eligible (checked_out) lines show request buttons
 *   - Ineligible (pending/returned) lines do not show request buttons
 *   - Call-off submission calls correct RPC and shows pending badge
 *   - Extension submission with urgency/note
 *   - RPC submission error shows error state
 *   - Existing request from server shows queued badge (pending state rendering)
 *   - Contract test: submission does NOT mutate rental line status
 *   - usePortalSession helper: extractPortalSessionFields
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------

const { rpcMock, getSessionMock, onAuthStateChangeMock, signInWithOtpMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  getSessionMock: vi.fn(),
  onAuthStateChangeMock: vi.fn(),
  signInWithOtpMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    auth: {
      getSession: getSessionMock,
      onAuthStateChange: onAuthStateChangeMock,
      signInWithOtp: signInWithOtpMock,
    },
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
  };
});

import {
  PortalRequestsScreen,
  PortalSignInPanel,
  recommendedDispositionForRequestType,
} from '@/routes/portal/requests';
import { extractPortalSessionFields } from '@/hooks/usePortalSession';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'contract-abc';
const LINE_CHECKED_OUT = 'line-checked-001';
const LINE_PENDING = 'line-pending-002';
const ASSET_ID_1 = 'asset-001';
const ASSET_ID_2 = 'asset-002';

type MockSession = {
  user: { id: string; email: string; app_metadata: Record<string, unknown> };
  access_token: string;
};

function makePortalSession(overrides: Partial<MockSession['user']['app_metadata']> = {}): MockSession {
  return {
    user: {
      id: 'user-portal-1',
      email: 'customer@example.com',
      app_metadata: { role: 'portal_customer', customer_id: 'cust-001', ...overrides },
    },
    access_token: 'token-abc',
  };
}

function makeStaffSession(): MockSession {
  return {
    user: {
      id: 'user-staff-1',
      email: 'operator@dia.com',
      app_metadata: { role: 'branch_manager' },
    },
    access_token: 'token-staff',
  };
}

function mockAuthState(session: MockSession | null) {
  getSessionMock.mockResolvedValue({ data: { session }, error: null });
  onAuthStateChangeMock.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
}

function mockRentals(rows: Record<string, unknown>[]) {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'portal_get_authenticated_rentals') {
      return Promise.resolve({ data: rows, error: null });
    }
    if (fn === 'portal_list_authenticated_service_requests') {
      return Promise.resolve({ data: [], error: null });
    }
    if (fn === 'portal_submit_authenticated_service_request') {
      return Promise.resolve({ data: [{ request_id: 'new-request-1' }], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

function defaultRentalRows(): Record<string, unknown>[] {
  return [
    {
      contract_entity_id: CONTRACT_ID,
      contract_status: 'active',
      contract_number: 'RC-2001',
      line_entity_id: LINE_CHECKED_OUT,
      line_status: 'checked_out',
      line_asset_id: ASSET_ID_1,
      line_actual_start: '2026-06-01T08:00:00.000Z',
      line_actual_end: null,
      line_data: { planned_end: '2026-07-15T17:00:00.000Z' },
      asset_name: 'Excavator XL',
      asset_status: 'on_rent',
    },
    {
      contract_entity_id: CONTRACT_ID,
      contract_status: 'active',
      contract_number: 'RC-2001',
      line_entity_id: LINE_PENDING,
      line_status: 'pending',
      line_asset_id: ASSET_ID_2,
      line_actual_start: null,
      line_actual_end: null,
      line_data: { planned_start: '2026-07-01T08:00:00.000Z' },
      asset_name: 'Forklift 5T',
      asset_status: 'available',
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PortalRequestsScreen — unauthenticated', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    getSessionMock.mockReset();
    onAuthStateChangeMock.mockReset();
    signInWithOtpMock.mockReset();
    mockAuthState(null);
  });

  it('renders the portal page container', async () => {
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('portal-requests-page')).toBeInTheDocument();
    });
  });

  it('shows sign-in form when session is absent', async () => {
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('portal-sign-in-form')).toBeInTheDocument();
    });
  });

  it('shows sign-in form when session has a non-portal_customer role', async () => {
    mockAuthState(makeStaffSession());
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('portal-sign-in-form')).toBeInTheDocument();
    });
  });

  it('does not call any RPC when unauthenticated', async () => {
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('portal-sign-in-form')).toBeInTheDocument();
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('PortalRequestsScreen — authenticated portal_customer', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    getSessionMock.mockReset();
    onAuthStateChangeMock.mockReset();
    signInWithOtpMock.mockReset();
    mockAuthState(makePortalSession());
    mockRentals(defaultRentalRows());
  });

  it('shows loading indicator while data is being fetched', () => {
    // Make the RPC hang briefly so we can observe the loading state
    rpcMock.mockImplementation(() => new Promise(() => {}));
    render(<PortalRequestsScreen />);
    expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
  });

  it('shows the authenticated user email in the header', async () => {
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('portal-user-email')).toHaveTextContent('customer@example.com');
    });
  });

  it('renders the rental lines list after loading', async () => {
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('rental-lines-list')).toBeInTheDocument();
    });
  });

  it('renders eligible (checked_out) line card', async () => {
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId(`rental-line-${LINE_CHECKED_OUT}`)).toBeInTheDocument();
      expect(screen.getByText('Excavator XL')).toBeInTheDocument();
    });
  });

  it('shows request buttons for checked_out line', async () => {
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`)).toBeInTheDocument();
      expect(screen.getByTestId(`request-${LINE_CHECKED_OUT}-contract_extension`)).toBeInTheDocument();
      expect(screen.getByTestId(`request-${LINE_CHECKED_OUT}-field_service`)).toBeInTheDocument();
    });
  });

  it('does NOT show request buttons for pending (ineligible) lines', async () => {
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('rental-lines-list')).toBeInTheDocument();
    });
    // The pending line is not checked_out, so it should not appear in eligibleLines
    expect(screen.queryByTestId(`request-${LINE_PENDING}-off_rent_pickup`)).not.toBeInTheDocument();
  });

  it('shows no-eligible-lines message when all lines are pending/returned', async () => {
    mockRentals([
      {
        ...defaultRentalRows()[1], // pending only
      },
    ]);
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('no-eligible-lines')).toBeInTheDocument();
    });
  });

  it('shows empty state when no rental lines exist', async () => {
    mockRentals([]);
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
  });

  it('shows a load-error alert when the rental RPC fails', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'portal_get_authenticated_rentals') {
        return Promise.resolve({ data: null, error: { message: 'RPC permission denied' } });
      }
      return Promise.resolve({ data: [], error: null });
    });
    render(<PortalRequestsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('load-error')).toBeInTheDocument();
      expect(screen.getByText('RPC permission denied')).toBeInTheDocument();
    });
  });
});

describe('PortalRequestsScreen — request submission', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    getSessionMock.mockReset();
    onAuthStateChangeMock.mockReset();
    signInWithOtpMock.mockReset();
    mockAuthState(makePortalSession());
    mockRentals(defaultRentalRows());
  });

  it('submits a call-off request and shows success badge', async () => {
    const user = userEvent.setup();
    render(<PortalRequestsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`));
    await user.click(screen.getByTestId(`submit-request-${LINE_CHECKED_OUT}`));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'portal_submit_authenticated_service_request',
        expect.objectContaining({
          p_contract_id: CONTRACT_ID,
          p_contract_line_id: LINE_CHECKED_OUT,
          p_request_type: 'off_rent_pickup',
        }),
      );
      expect(screen.getByTestId('submit-success')).toBeInTheDocument();
      expect(screen.getByTestId(`requested-${LINE_CHECKED_OUT}-off_rent_pickup`)).toBeInTheDocument();
    });
  });

  it('submits an extension request with urgency and note', async () => {
    const user = userEvent.setup();
    render(<PortalRequestsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId(`request-${LINE_CHECKED_OUT}-contract_extension`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`request-${LINE_CHECKED_OUT}-contract_extension`));
    await user.selectOptions(screen.getByTestId(`select-type-${LINE_CHECKED_OUT}`), 'contract_extension');
    await user.selectOptions(screen.getByTestId(`select-urgency-${LINE_CHECKED_OUT}`), 'high');
    await user.type(screen.getByTestId(`note-${LINE_CHECKED_OUT}`), 'Need 7 more days due to weather');
    await user.click(screen.getByTestId(`submit-request-${LINE_CHECKED_OUT}`));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'portal_submit_authenticated_service_request',
        expect.objectContaining({
          p_request_type: 'contract_extension',
          p_urgency: 'high',
          p_customer_note: 'Need 7 more days due to weather',
        }),
      );
      expect(screen.getByTestId(`requested-${LINE_CHECKED_OUT}-contract_extension`)).toBeInTheDocument();
    });
  });

  it('submits a field service request with missing-context flag', async () => {
    const user = userEvent.setup();
    render(<PortalRequestsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId(`request-${LINE_CHECKED_OUT}-field_service`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`request-${LINE_CHECKED_OUT}-field_service`));
    await user.selectOptions(screen.getByTestId(`select-type-${LINE_CHECKED_OUT}`), 'field_service');
    await user.selectOptions(screen.getByTestId(`select-urgency-${LINE_CHECKED_OUT}`), 'critical');
    await user.click(screen.getByTestId(`missing-context-${LINE_CHECKED_OUT}`));
    await user.click(screen.getByTestId(`submit-request-${LINE_CHECKED_OUT}`));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'portal_submit_authenticated_service_request',
        expect.objectContaining({
          p_request_type: 'field_service',
          p_urgency: 'critical',
          p_missing_contract_context: true,
        }),
      );
    });
  });

  it('shows a submit error when the RPC fails', async () => {
    const user = userEvent.setup();
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'portal_get_authenticated_rentals') {
        return Promise.resolve({ data: defaultRentalRows(), error: null });
      }
      if (fn === 'portal_list_authenticated_service_requests') {
        return Promise.resolve({ data: [], error: null });
      }
      if (fn === 'portal_submit_authenticated_service_request') {
        return Promise.resolve({ data: null, error: { message: 'Contract outside customer scope' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<PortalRequestsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`));
    await user.click(screen.getByTestId(`submit-request-${LINE_CHECKED_OUT}`));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeInTheDocument();
      expect(screen.getByText('Contract outside customer scope')).toBeInTheDocument();
    });
  });
});

describe('PortalRequestsScreen — pending state from server', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    getSessionMock.mockReset();
    onAuthStateChangeMock.mockReset();
    mockAuthState(makePortalSession());
  });

  it('shows queued badge for an existing request returned from the server', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'portal_get_authenticated_rentals') {
        return Promise.resolve({ data: defaultRentalRows(), error: null });
      }
      if (fn === 'portal_list_authenticated_service_requests') {
        return Promise.resolve({
          data: [
            {
              request_id: 'existing-req-1',
              contract_id: CONTRACT_ID,
              contract_line_id: LINE_CHECKED_OUT,
              asset_id: ASSET_ID_1,
              job_site_id: null,
              request_type: 'off_rent_pickup',
              status: 'requested',
              urgency: 'standard',
              reason: 'Customer called off from portal',
              customer_note: null,
              has_supporting_photos: false,
              missing_contract_context: false,
              evidence_gaps: ['supporting_photos_missing'],
              recommended_disposition: 'Review pickup/call-off readiness.',
              requires_human_approval: true,
              requested_at: '2026-06-17T10:00:00.000Z',
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<PortalRequestsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId(`requested-${LINE_CHECKED_OUT}-off_rent_pickup`)).toBeInTheDocument();
    });
    // The request button should be replaced by the badge
    expect(screen.queryByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`)).not.toBeInTheDocument();
  });

  it('shows the existing requests section with status badge', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'portal_get_authenticated_rentals') {
        return Promise.resolve({ data: defaultRentalRows(), error: null });
      }
      if (fn === 'portal_list_authenticated_service_requests') {
        return Promise.resolve({
          data: [
            {
              request_id: 'req-detail-1',
              contract_id: CONTRACT_ID,
              contract_line_id: LINE_CHECKED_OUT,
              asset_id: ASSET_ID_1,
              job_site_id: null,
              request_type: 'contract_extension',
              status: 'under_review',
              urgency: 'high',
              reason: 'Need 7 more days',
              customer_note: 'Need 7 more days',
              has_supporting_photos: false,
              missing_contract_context: false,
              evidence_gaps: [],
              recommended_disposition: 'Validate extension terms.',
              requires_human_approval: true,
              requested_at: '2026-06-17T08:00:00.000Z',
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<PortalRequestsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('existing-requests-section')).toBeInTheDocument();
    });
    expect(screen.getByTestId('request-record-req-detail-1')).toBeInTheDocument();
    expect(screen.getByTestId('request-status-req-detail-1')).toHaveTextContent('under review');
  });
});

describe('PortalRequestsScreen — contract no-mutation contract test', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    getSessionMock.mockReset();
    onAuthStateChangeMock.mockReset();
    mockAuthState(makePortalSession());
    mockRentals(defaultRentalRows());
  });

  it('does not call any rental-mutation RPC after request submission', async () => {
    const MUTATING_RPCS = [
      'checkout_contract_line',
      'return_contract_line',
      'cancel_contract',
      'update_contract_status',
      'update_rental_line',
    ];

    const user = userEvent.setup();
    render(<PortalRequestsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`));
    await user.click(screen.getByTestId(`submit-request-${LINE_CHECKED_OUT}`));

    await waitFor(() => {
      expect(screen.getByTestId('submit-success')).toBeInTheDocument();
    });

    for (const rpcName of MUTATING_RPCS) {
      expect(rpcMock).not.toHaveBeenCalledWith(rpcName, expect.anything());
    }
  });

  it('rental line status in local state is not changed after request submission', async () => {
    const user = userEvent.setup();
    render(<PortalRequestsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId(`rental-line-${LINE_CHECKED_OUT}`)).toBeInTheDocument();
    });

    // Capture the initial badge text for the checked_out line
    const onRentBadge = screen.getAllByText('On Rent');
    expect(onRentBadge.length).toBeGreaterThan(0);

    await user.click(screen.getByTestId(`request-${LINE_CHECKED_OUT}-off_rent_pickup`));
    await user.click(screen.getByTestId(`submit-request-${LINE_CHECKED_OUT}`));

    await waitFor(() => {
      expect(screen.getByTestId('submit-success')).toBeInTheDocument();
    });

    // The line card itself still shows "On Rent" — status was not mutated
    expect(screen.getAllByText('On Rent').length).toBeGreaterThan(0);
  });
});

describe('PortalSignInPanel', () => {
  beforeEach(() => {
    signInWithOtpMock.mockReset();
    getSessionMock.mockReset();
    onAuthStateChangeMock.mockReset();
    mockAuthState(null);
  });

  it('renders the email input and submit button', () => {
    render(<PortalSignInPanel />);
    expect(screen.getByTestId('portal-email-input')).toBeInTheDocument();
    expect(screen.getByTestId('portal-sign-in-button')).toBeInTheDocument();
  });

  it('sends a magic-link and shows confirmation', async () => {
    const user = userEvent.setup();
    signInWithOtpMock.mockResolvedValue({ error: null });

    render(<PortalSignInPanel />);

    await user.type(screen.getByTestId('portal-email-input'), 'customer@example.com');
    await user.click(screen.getByTestId('portal-sign-in-button'));

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-sent')).toBeInTheDocument();
    });

    expect(signInWithOtpMock).toHaveBeenCalledWith({
      email: 'customer@example.com',
      options: { shouldCreateUser: false },
    });
  });

  it('shows an error when OTP fails', async () => {
    const user = userEvent.setup();
    signInWithOtpMock.mockResolvedValue({ error: { message: 'Email not found' } });

    render(<PortalSignInPanel />);

    await user.type(screen.getByTestId('portal-email-input'), 'unknown@example.com');
    await user.click(screen.getByTestId('portal-sign-in-button'));

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error')).toBeInTheDocument();
      expect(screen.getByText('Email not found')).toBeInTheDocument();
    });
  });

  it('shows validation error when email is empty', async () => {
    const user = userEvent.setup();
    render(<PortalSignInPanel />);

    await user.click(screen.getByTestId('portal-sign-in-button'));

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error')).toBeInTheDocument();
      expect(screen.getByText('Please enter your email address.')).toBeInTheDocument();
    });
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for extractPortalSessionFields
// ---------------------------------------------------------------------------

describe('extractPortalSessionFields', () => {
  it('returns isPortalCustomer=false for null session', () => {
    const result = extractPortalSessionFields(null);
    expect(result.isPortalCustomer).toBe(false);
    expect(result.customerIds).toEqual([]);
    expect(result.userId).toBeNull();
  });

  it('returns isPortalCustomer=true for portal_customer role', () => {
    const session = {
      user: {
        id: 'u-1',
        email: 'c@ex.com',
        app_metadata: { role: 'portal_customer', customer_id: 'cust-abc' },
      },
    } as Parameters<typeof extractPortalSessionFields>[0];
    const result = extractPortalSessionFields(session);
    expect(result.isPortalCustomer).toBe(true);
    expect(result.customerIds).toContain('cust-abc');
    expect(result.userId).toBe('u-1');
  });

  it('returns isPortalCustomer=false for non-portal role', () => {
    const session = {
      user: {
        id: 'u-2',
        email: 'op@dia.com',
        app_metadata: { role: 'branch_manager' },
      },
    } as Parameters<typeof extractPortalSessionFields>[0];
    const result = extractPortalSessionFields(session);
    expect(result.isPortalCustomer).toBe(false);
  });

  it('aggregates multiple customer_ids from app_metadata', () => {
    const session = {
      user: {
        id: 'u-3',
        email: 'c@ex.com',
        app_metadata: { role: 'portal_customer', customer_ids: ['cust-1', 'cust-2'] },
      },
    } as Parameters<typeof extractPortalSessionFields>[0];
    const result = extractPortalSessionFields(session);
    expect(result.customerIds).toContain('cust-1');
    expect(result.customerIds).toContain('cust-2');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for recommendedDispositionForRequestType
// ---------------------------------------------------------------------------

describe('recommendedDispositionForRequestType', () => {
  it('returns pickup/call-off disposition for off_rent_pickup', () => {
    expect(recommendedDispositionForRequestType('off_rent_pickup')).toMatch(/pickup\/call-off/i);
  });

  it('returns extension disposition for contract_extension', () => {
    expect(recommendedDispositionForRequestType('contract_extension')).toMatch(/extension/i);
  });

  it('returns triage disposition for field_service', () => {
    expect(recommendedDispositionForRequestType('field_service')).toMatch(/triage/i);
  });
});
