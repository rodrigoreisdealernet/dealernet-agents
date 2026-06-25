import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mock supabase
// ---------------------------------------------------------------------------

const { fromMock, rpcMock, storageFromMock, uploadMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  storageFromMock: vi.fn(),
  uploadMock: vi.fn(),
}));

const { authState } = vi.hoisted(() => ({
  authState: {
    profile: {
      id: 'driver-uuid-0001',
      role: 'field_operator' as 'admin' | 'branch_manager' | 'field_operator' | 'read_only',
    },
  },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
    rpc: rpcMock,
    storage: { from: storageFromMock },
  },
}));

import {
  DriverDispatchScreen,
  buildMapsUrl,
  nextStopStatus,
  loadTodayStops,
  loadDvirQueue,
} from '@/routes/field/dispatch';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10);

function makeStop(overrides: Record<string, unknown> = {}) {
  return {
    stop_id: 'stop-1',
    route_id: 'route-1',
    driver_id: 'driver-uuid-0001',
    route_date: TODAY,
    route_status: 'pending',
    sequence_order: 0,
    stop_type: 'delivery',
    stop_status: 'pending',
    contract_line_id: 'line-1',
    asset_id: 'asset-1',
    address: '1 Main St, Anytown',
    address_lat: 51.5072,
    address_lng: -0.1276,
    customer_name: 'Acme Construction',
    job_site_name: 'Site Alpha',
    contact_name: 'Jane Site',
    contact_phone: '555-0100',
    notes: 'Leave by gate',
    signature: null,
    condition_notes: null,
    photo_paths: [],
    departed_at: null,
    arrived_at: null,
    completed_at: null,
    telemetry_position_status: 'unknown',
    eld_compliance_status: 'unknown',
    driver_log_status: 'unknown',
    telemetry_event_at: null,
    created_at: '2026-06-09T06:00:00Z',
    updated_at: '2026-06-09T06:00:00Z',
    ...overrides,
  };
}

function mockStopsTable(stops: ReturnType<typeof makeStop>[]) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'v_driver_dispatch_stops') {
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: stops, error: null }),
      };
      return query;
    }
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
  });
}

// ---------------------------------------------------------------------------
// Pure function unit tests
// ---------------------------------------------------------------------------

describe('nextStopStatus', () => {
  it('pending → departed', () => expect(nextStopStatus('pending')).toBe('departed'));
  it('departed → arrived', () => expect(nextStopStatus('departed')).toBe('arrived'));
  it('arrived → completed', () => expect(nextStopStatus('arrived')).toBe('completed'));
  it('completed → null', () => expect(nextStopStatus('completed')).toBeNull());
});

describe('buildMapsUrl', () => {
  it('uses lat/lng when available', () => {
    expect(buildMapsUrl('1 Main St', 51.5072, -0.1276)).toBe(
      'https://maps.google.com/?q=51.5072,-0.1276'
    );
  });

  it('falls back to encoded address when no coordinates', () => {
    expect(buildMapsUrl('1 Main St, Anytown', null, null)).toBe(
      'https://maps.google.com/?q=1%20Main%20St%2C%20Anytown'
    );
  });
});

describe('loadTodayStops', () => {
  it('maps view rows to RouteStop objects', async () => {
    mockStopsTable([makeStop()]);
    const stops = await loadTodayStops('driver-uuid-0001');
    expect(stops).toHaveLength(1);
    const s = stops[0];
    expect(s.stopId).toBe('stop-1');
    expect(s.stopType).toBe('delivery');
    expect(s.stopStatus).toBe('pending');
    expect(s.customerName).toBe('Acme Construction');
    expect(s.addressLat).toBe(51.5072);
    expect(s.photoPaths).toEqual([]);
    expect(s.eldComplianceStatus).toBe('unknown');
    expect(s.contactName).toBe('Jane Site');
    expect(s.contactPhone).toBe('555-0100');
  });

  it('maps null contact fields when not provided by the view', async () => {
    mockStopsTable([makeStop({ contact_name: null, contact_phone: null })]);
    const stops = await loadTodayStops('driver-uuid-0001');
    expect(stops[0].contactName).toBeNull();
    expect(stops[0].contactPhone).toBeNull();
  });

  it('returns empty array when no stops assigned', async () => {
    mockStopsTable([]);
    const stops = await loadTodayStops('driver-uuid-0001');
    expect(stops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DriverDispatchScreen integration tests
// ---------------------------------------------------------------------------

describe('DriverDispatchScreen', () => {
  beforeEach(() => {
    authState.profile = { id: 'driver-uuid-0001', role: 'field_operator' };
    Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => {},
    });
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: () => {},
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => {},
    });
    fromMock.mockReset();
    rpcMock.mockReset();
    storageFromMock.mockReset();
    uploadMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: null });
    uploadMock.mockResolvedValue({ error: null });
    storageFromMock.mockReturnValue({ upload: uploadMock });
    // Reset localStorage queues.
    localStorage.removeItem('dispatch_action_queue');
    localStorage.removeItem('dispatch_dvir_queue');
  });

  it('renders the Driver Dispatch heading', async () => {
    mockStopsTable([]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Driver Dispatch')).toBeInTheDocument();
    });
  });

  it('shows empty state when no stops assigned', async () => {
    mockStopsTable([]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('No stops assigned for today.')).toBeInTheDocument();
    });
  });

  it('renders stop cards for assigned stops', async () => {
    mockStopsTable([makeStop(), makeStop({ stop_id: 'stop-2', sequence_order: 1, stop_type: 'pickup', customer_name: 'Beta Corp' })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
      expect(screen.getByText('Beta Corp')).toBeInTheDocument();
    });
  });

  it('shows a navigation link for stops with an address', async () => {
    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      const navLink = screen.getByRole('link', { name: /navigate to stop/i });
      expect(navLink).toHaveAttribute(
        'href',
        'https://maps.google.com/?q=51.5072,-0.1276'
      );
    });
  });

  it('expands action panel when expand button is clicked', async () => {
    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    expect(
      screen.getByRole('button', { name: /mark as departed/i })
    ).toBeInTheDocument();
  });

  it('collapses action panel when toggled a second time', async () => {
    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    const expandBtn = screen.getByRole('button', { name: /expand stop actions/i });
    await userEvent.click(expandBtn);
    expect(screen.getByRole('button', { name: /mark as departed/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /collapse stop actions/i }));
    expect(screen.queryByRole('button', { name: /mark as departed/i })).not.toBeInTheDocument();
  });

  it('shows signature and condition notes fields when advancing to completed', async () => {
    mockStopsTable([makeStop({ stop_status: 'arrived' })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    expect(screen.getByLabelText('Signature')).toBeInTheDocument();
    expect(screen.getByLabelText('Condition notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark as completed/i })).toBeInTheDocument();
  });

  it('does not show signature / condition fields for depart action', async () => {
    mockStopsTable([makeStop({ stop_status: 'pending' })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    expect(screen.queryByLabelText('Signature')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Condition notes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark as departed/i })).toBeInTheDocument();
  });

  it('calls update_route_stop_state RPC on Depart', async () => {
    mockStopsTable([makeStop()]);
    rpcMock.mockResolvedValue({ data: { stop_id: 'stop-1', status: 'departed' }, error: null });

    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    await userEvent.click(screen.getByRole('button', { name: /mark as departed/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('update_route_stop_state', expect.objectContaining({
        p_stop_id: 'stop-1',
        p_status: 'departed',
      }));
    });
  });

  it('calls update_route_stop_state RPC on Complete with signature and condition notes', async () => {
    mockStopsTable([makeStop({ stop_status: 'arrived' })]);
    rpcMock.mockResolvedValue({ data: { stop_id: 'stop-1', status: 'completed' }, error: null });

    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    await userEvent.type(screen.getByLabelText('Signature'), 'Jane Driver');
    await userEvent.type(screen.getByLabelText('Condition notes'), 'No damage found');
    await userEvent.click(screen.getByRole('button', { name: /mark as completed/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('update_route_stop_state', expect.objectContaining({
        p_stop_id: 'stop-1',
        p_status: 'completed',
        p_signature: 'Jane Driver',
        p_condition_notes: 'No damage found',
      }));
    });
  });

  it('shows completed checkmark and no expand button for completed stops', async () => {
    mockStopsTable([makeStop({ stop_status: 'completed', completed_at: '2026-06-09T10:00:00Z' })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    // Completed stops show no expand button
    expect(screen.queryByRole('button', { name: /expand stop actions/i })).not.toBeInTheDocument();
  });

  it('renders normalized compliance and telemetry status text for each stop', async () => {
    mockStopsTable([
      makeStop({
        telemetry_position_status: 'stale',
        eld_compliance_status: 'warning',
        driver_log_status: 'missing',
      }),
    ]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText(/ELD warning/i)).toBeInTheDocument();
      expect(screen.getByText(/Driver log Missing/i)).toBeInTheDocument();
      expect(screen.getByText(/GPS stale/i)).toBeInTheDocument();
    });
  });

  // ── Compliance state persistence and route-progression coverage ────────────

  it('shows load error alert when Supabase returns an error', async () => {
    fromMock.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: null, error: { message: 'Connection timeout' } }),
    }));

    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Could not load stops')).toBeInTheDocument();
    });
    // The Supabase error object is not instanceof Error, so the fallback message is used.
    expect(screen.getByText('Failed to load stops.')).toBeInTheDocument();
  });

  it('compliance state is visible in-context after remount (reload simulation)', async () => {
    mockStopsTable([
      makeStop({
        telemetry_position_status: 'fresh',
        eld_compliance_status: 'compliant',
        driver_log_status: 'current',
      }),
    ]);

    const { unmount } = render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText(/ELD Compliant/i)).toBeInTheDocument();
      expect(screen.getByText(/GPS Fresh/i)).toBeInTheDocument();
      expect(screen.getByText(/Driver log Current/i)).toBeInTheDocument();
    });

    // Simulate a page reload by unmounting and remounting with the same mock data.
    unmount();
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText(/ELD Compliant/i)).toBeInTheDocument();
      expect(screen.getByText(/GPS Fresh/i)).toBeInTheDocument();
      expect(screen.getByText(/Driver log Current/i)).toBeInTheDocument();
    });
  });

  it('compliance state remains visible after a stop advances to departed', async () => {
    const refreshData = [
      makeStop({
        stop_status: 'departed',
        departed_at: '2026-06-09T09:00:00Z',
        telemetry_position_status: 'stale',
        eld_compliance_status: 'warning',
        driver_log_status: 'current',
      }),
    ];

    mockStopsTable([makeStop()]);
    rpcMock.mockResolvedValue({ data: { stop_id: 'stop-1', status: 'departed' }, error: null });

    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    // Set up the mock so the refreshStops() call after RPC returns the updated row.
    mockStopsTable(refreshData);

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    await userEvent.click(screen.getByRole('button', { name: /mark as departed/i }));

    await waitFor(() => {
      // After route progression the refreshed data still carries compliance fields.
      expect(screen.getByText(/ELD warning/i)).toBeInTheDocument();
      expect(screen.getByText(/GPS stale/i)).toBeInTheDocument();
    });
  });

  it('compliance state visible on completed stops (stop card header, no action panel)', async () => {
    mockStopsTable([
      makeStop({
        stop_status: 'completed',
        completed_at: '2026-06-09T11:00:00Z',
        telemetry_position_status: 'fresh',
        eld_compliance_status: 'violation',
        driver_log_status: 'out_of_hours',
      }),
    ]);

    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    // No expand button for completed stops — compliance info still readable in card header.
    expect(screen.queryByRole('button', { name: /expand stop actions/i })).not.toBeInTheDocument();
    expect(screen.getByText(/ELD Violation/i)).toBeInTheDocument();
    expect(screen.getByText(/GPS Fresh/i)).toBeInTheDocument();
    expect(screen.getByText(/Driver log Out of hours/i)).toBeInTheDocument();
  });

  it('compliance unknown default is visible when telemetry fields are not yet received', async () => {
    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });
    expect(screen.getByText(/ELD Unknown/i)).toBeInTheDocument();
    expect(screen.getByText(/GPS Unknown/i)).toBeInTheDocument();
    expect(screen.getByText(/Driver log Unknown/i)).toBeInTheDocument();
  });

  it('queues action when offline and updates local state optimistically', async () => {
    // Simulate offline
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });

    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    await userEvent.click(screen.getByRole('button', { name: /mark as departed/i }));

    await waitFor(() => {
      expect(screen.getByText(/action queued \(offline\)/i)).toBeInTheDocument();
    });

    // RPC should NOT have been called
    expect(rpcMock).not.toHaveBeenCalled();

    // Queue should have an entry
    const queue = JSON.parse(localStorage.getItem('dispatch_action_queue') ?? '[]') as unknown[];
    expect(queue).toHaveLength(1);

    // Restore
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
  });

  it('keeps queued stop progression and evidence visible after remount before replay succeeds', async () => {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    localStorage.setItem(
      'dispatch_action_queue',
      JSON.stringify([
        {
          id: 'queued-stop-1',
          stopId: 'stop-1',
          targetStatus: 'completed',
          signature: 'Jane Driver',
          conditionNotes: 'Condition note from offline completion',
          photoPaths: ['dispatch-stops/stop-1/proof.jpg'],
          queuedAt: '2026-06-09T10:15:00Z',
          retries: 0,
        },
      ])
    );

    mockStopsTable([makeStop({ stop_status: 'arrived', arrived_at: '2026-06-09T10:10:00Z' })]);

    const { unmount } = render(<DriverDispatchScreen />);

    await waitFor(() => {
      expect(screen.getByText(/queued offline/i)).toBeInTheDocument();
    });
    const stopCard = screen.getByTestId('stop-card-stop-1');
    expect(within(stopCard).getByText('Completed')).toBeInTheDocument();
    expect(within(stopCard).getByText('Queued replay')).toBeInTheDocument();
    expect(within(stopCard).getByText('✓ Signature')).toBeInTheDocument();
    expect(within(stopCard).getByText(/Condition: Condition note from offline completion/i)).toBeInTheDocument();
    expect(within(stopCard).getByText(/✓ 1 photo/i)).toBeInTheDocument();

    unmount();
    render(<DriverDispatchScreen />);

    await waitFor(() => {
      expect(screen.getByText(/queued offline/i)).toBeInTheDocument();
    });
    const reloadedStopCard = screen.getByTestId('stop-card-stop-1');
    expect(within(reloadedStopCard).getByText('Completed')).toBeInTheDocument();
    expect(within(reloadedStopCard).getByText('Queued replay')).toBeInTheDocument();
    expect(within(reloadedStopCard).getByText('✓ Signature')).toBeInTheDocument();
    expect(
      within(reloadedStopCard).getByText(/Condition: Condition note from offline completion/i)
    ).toBeInTheDocument();
    expect(within(reloadedStopCard).getByText(/✓ 1 photo/i)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('dispatch_action_queue') ?? '[]')).toHaveLength(1);

    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
  });

  // ── Run-sheet readiness ────────────────────────────────────────────────────

  it('shows run-sheet readiness alert when stops are missing address or customer data', async () => {
    mockStopsTable([
      makeStop({ address: null, customer_name: null, contact_name: 'Jane Site' }),
      makeStop({ stop_id: 'stop-2', sequence_order: 1, address: '2 Oak Ave', customer_name: 'Beta Corp' }),
    ]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText(/1 stop with incomplete dispatch data/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/stop 1/i)).toBeInTheDocument();
    expect(screen.getByText(/missing address/i)).toBeInTheDocument();
    expect(screen.getByText(/missing customer/i)).toBeInTheDocument();
  });

  it('flags stops with missing contact as incomplete in the readiness banner', async () => {
    mockStopsTable([
      makeStop({ contact_name: null }),
      makeStop({ stop_id: 'stop-2', sequence_order: 1, customer_name: 'Beta Corp' }),
    ]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText(/1 stop with incomplete dispatch data/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/missing contact/i)).toBeInTheDocument();
  });

  it('does not show run-sheet readiness alert when all pending stops have complete data', async () => {
    mockStopsTable([
      makeStop(),
      makeStop({ stop_id: 'stop-2', sequence_order: 1, customer_name: 'Beta Corp' }),
    ]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });
    expect(screen.queryByText(/incomplete dispatch data/i)).not.toBeInTheDocument();
  });

  it('does not flag completed stops as incomplete in the readiness banner', async () => {
    mockStopsTable([
      makeStop({ stop_status: 'completed', completed_at: '2026-06-09T10:00:00Z', address: null, contact_name: null }),
    ]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });
    expect(screen.queryByText(/incomplete dispatch data/i)).not.toBeInTheDocument();
  });

  // ── Contact details per stop ───────────────────────────────────────────────

  it('shows contact name and phone in the stop card when provided', async () => {
    mockStopsTable([makeStop({ contact_name: 'Bob Foreman', contact_phone: '555-9876' })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText(/Bob Foreman/)).toBeInTheDocument();
    });
    expect(screen.getByText(/555-9876/)).toBeInTheDocument();
  });

  it('shows contact name without phone when phone is absent', async () => {
    mockStopsTable([makeStop({ contact_name: 'Alice Supervisor', contact_phone: null })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText(/Alice Supervisor/)).toBeInTheDocument();
    });
  });

  it('does not render a contact line when both contact fields are null', async () => {
    mockStopsTable([makeStop({ contact_name: null, contact_phone: null })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });
    expect(screen.queryByText(/^Contact:/)).not.toBeInTheDocument();
  });

  // ── DVIR card ─────────────────────────────────────────────────────────────

  it('shows pre-trip DVIR card with Pending badge when stops are loaded and DVIR not yet submitted', async () => {
    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Pre-trip DVIR')).toBeInTheDocument();
    });
    // Use getByRole to find the DVIR-specific "Pending" badge (the stop also carries a Pending badge).
    const dvirHeading = screen.getByText('Pre-trip DVIR');
    const dvirCard = dvirHeading.closest('[class*="card"]') ?? dvirHeading.closest('div[class]')!;
    expect(dvirCard).not.toBeNull();
    expect(dvirCard.textContent).toContain('Pending');
    expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
  });

  it('shows pre-trip DVIR card with Completed badge when DVIR already submitted', async () => {
    mockStopsTable([makeStop({ dvir_submitted: true })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Pre-trip DVIR')).toBeInTheDocument();
    });
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start dvir/i })).not.toBeInTheDocument();
  });

  it('expands DVIR form when Start DVIR is clicked', async () => {
    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));
    expect(screen.getByLabelText(/truck \/ unit id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/odometer reading/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/truck is safe to drive/i)).toBeInTheDocument();
  });

  it('shows unsafe-vehicle escalation warning when safe-to-drive is unchecked', async () => {
    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));
    // Uncheck safe-to-drive
    const safeCheckbox = screen.getByLabelText(/truck is safe to drive/i);
    await userEvent.click(safeCheckbox);

    expect(
      screen.getByText(/safety exception will be escalated for branch review/i)
    ).toBeInTheDocument();
  });

  it('requires a driver signature before DVIR can be submitted', async () => {
    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));
    await userEvent.type(screen.getByLabelText(/truck \/ unit id/i), 'TRK-042');
    await userEvent.click(screen.getByRole('button', { name: /submit dvir/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/driver signature is required before submitting dvir/i)
      ).toBeInTheDocument();
    });
    expect(rpcMock).not.toHaveBeenCalledWith('submit_dvir', expect.anything());
  });

  it('calls submit_dvir RPC with correct payload when DVIR submitted online', async () => {
    rpcMock.mockResolvedValue({ data: 'dvir-uuid-0001', error: null });
    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));
    await userEvent.type(screen.getByLabelText(/truck \/ unit id/i), 'TRK-042');
    await userEvent.type(screen.getByLabelText(/odometer reading/i), '45200');
    await userEvent.type(screen.getByLabelText(/driver signature/i), 'Jane Driver');
    await userEvent.click(screen.getByRole('button', { name: /submit dvir/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('submit_dvir', expect.objectContaining({
        p_route_id: 'route-1',
        p_truck_id: 'TRK-042',
        p_is_safe_to_drive: true,
        p_signature: 'Jane Driver',
      }));
    });
  });

  it('DVIR submission shows safety exception message when not safe to drive', async () => {
    rpcMock.mockResolvedValue({ data: 'dvir-uuid-0002', error: null });
    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));
    await userEvent.click(screen.getByLabelText(/truck is safe to drive/i));
    await userEvent.type(screen.getByLabelText(/driver signature/i), 'Jane Driver');
    await userEvent.click(screen.getByRole('button', { name: /submit dvir/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/safety exception flagged for branch review/i)
      ).toBeInTheDocument();
    });
  });

  it('can add and remove defects in the DVIR form', async () => {
    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));

    // Add a defect
    await userEvent.type(screen.getByLabelText(/defect description/i), 'Left rear tyre');
    await userEvent.click(screen.getByRole('button', { name: /add defect/i }));

    expect(screen.getByText('Left rear tyre')).toBeInTheDocument();

    // Remove the defect
    await userEvent.click(screen.getByRole('button', { name: /remove defect: left rear tyre/i }));
    expect(screen.queryByText('Left rear tyre')).not.toBeInTheDocument();
  });

  it('calls submit_dvir RPC with defects when defects have been added', async () => {
    rpcMock.mockResolvedValue({ data: 'dvir-uuid-0003', error: null });
    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));
    await userEvent.type(screen.getByLabelText(/defect description/i), 'Cracked windscreen');
    await userEvent.click(screen.getByRole('button', { name: /add defect/i }));
    await userEvent.type(screen.getByLabelText(/driver signature/i), 'Jane Driver');
    await userEvent.click(screen.getByRole('button', { name: /submit dvir/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('submit_dvir', expect.objectContaining({
        p_route_id: 'route-1',
        p_defects: [{ item: 'Cracked windscreen', severity: 'minor' }],
      }));
    });
  });

  it('queues DVIR submission when offline and does not call RPC', async () => {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });

    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));
    await userEvent.type(screen.getByLabelText(/truck \/ unit id/i), 'TRK-042');
    await userEvent.type(screen.getByLabelText(/driver signature/i), 'Jane Driver');
    await userEvent.click(screen.getByRole('button', { name: /submit dvir/i }));

    await waitFor(() => {
      expect(screen.getByText(/dvir saved offline/i)).toBeInTheDocument();
    });

    // RPC should NOT have been called
    expect(rpcMock).not.toHaveBeenCalledWith('submit_dvir', expect.anything());

    // DVIR queue should have an entry
    const dvirQueue = loadDvirQueue();
    expect(dvirQueue).toHaveLength(1);
    expect(dvirQueue[0].routeId).toBe('route-1');
    expect(dvirQueue[0].truckId).toBe('TRK-042');

    // Restore
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
  });

  it('hides Start DVIR button after offline save so a second submission cannot be queued', async () => {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });

    mockStopsTable([makeStop({ dvir_submitted: false })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start dvir/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /start dvir/i }));
    await userEvent.type(screen.getByLabelText(/truck \/ unit id/i), 'TRK-042');
    await userEvent.type(screen.getByLabelText(/driver signature/i), 'Jane Driver');
    await userEvent.click(screen.getByRole('button', { name: /submit dvir/i }));

    await waitFor(() => {
      expect(screen.getByText(/dvir saved offline/i)).toBeInTheDocument();
    });

    // "Start DVIR" button must be gone — DVIR is locally marked as queued.
    expect(screen.queryByRole('button', { name: /start dvir/i })).not.toBeInTheDocument();

    // Queue must still have exactly one entry for the correct route — no duplicates possible.
    const queued = loadDvirQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].routeId).toBe('route-1');
    expect(queued[0].truckId).toBe('TRK-042');

    // Restore
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
  });

  it('replays queued DVIR on mount when browser is already online', async () => {
    // Pre-populate localStorage with a queued DVIR from a previous offline session.
    localStorage.setItem(
      'dispatch_dvir_queue',
      JSON.stringify([
        {
          id: 'queued-id-1',
          routeId: 'route-1',
          truckId: 'TRK-99',
          odometerReading: '12345',
          defects: [],
          isSafeToDrive: true,
          notes: '',
          signature: 'Jane',
          queuedAt: new Date().toISOString(),
          retries: 0,
        },
      ])
    );

    rpcMock.mockResolvedValue({ data: 'dvir-uuid-replay', error: null });
    // After replay, refreshStops returns dvir_submitted: true.
    mockStopsTable([makeStop({ dvir_submitted: true })]);

    // Mount while already online.
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
    render(<DriverDispatchScreen />);

    // submit_dvir should be called during mount-time replay.
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('submit_dvir', expect.objectContaining({
        p_route_id: 'route-1',
        p_truck_id: 'TRK-99',
      }));
    });

    // Queue must be empty after successful replay.
    expect(loadDvirQueue()).toHaveLength(0);
  });

  // ── Exception submission ──────────────────────────────────────────────────

  it('shows exception count badge when a stop has unresolved exceptions', async () => {
    mockStopsTable([makeStop({ exception_count: 2 })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });
    expect(screen.getByText(/2 exceptions/i)).toBeInTheDocument();
  });

  it('calls submit_stop_exception RPC when exception is submitted', async () => {
    rpcMock.mockResolvedValue({ data: 'exc-uuid-0001', error: null });
    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    // Open action panel and then exception panel
    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    await userEvent.click(screen.getByRole('button', { name: /report exception/i }));
    await userEvent.type(screen.getByLabelText(/notes/i), 'Gate locked, no contact available');
    await userEvent.click(screen.getByRole('button', { name: /submit exception/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('submit_stop_exception', expect.objectContaining({
        p_stop_id: 'stop-1',
        p_exception_type: 'eta_delay',
        p_notes: 'Gate locked, no contact available',
      }));
    });
  });

  it('sends typed delay minutes when ETA delay exception is submitted', async () => {
    rpcMock.mockResolvedValue({ data: 'exc-uuid-0003', error: null });
    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    await userEvent.click(screen.getByRole('button', { name: /report exception/i }));
    await userEvent.type(screen.getByLabelText(/estimated delay \(minutes\)/i), '45');
    await userEvent.type(screen.getByLabelText(/^notes$/i), 'Traffic and roadworks');
    await userEvent.click(screen.getByRole('button', { name: /submit exception/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'submit_stop_exception',
        expect.objectContaining({
          p_exception_type: 'eta_delay',
          p_estimated_delay_minutes: 45,
          p_notes: 'Traffic and roadworks',
        })
      );
    });
  });

  it('switches exception-form branches for access and damage paths', async () => {
    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    await userEvent.click(screen.getByRole('button', { name: /report exception/i }));

    expect(screen.getByLabelText(/estimated delay \(minutes\)/i)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Exception type'));
    await userEvent.click(screen.getByRole('option', { name: /access issue/i }));
    expect(screen.queryByLabelText(/estimated delay \(minutes\)/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/describe access problem/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/evidence photos/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Exception type'));
    await userEvent.click(screen.getByRole('option', { name: 'Damage' }));
    expect(screen.getByPlaceholderText(/describe damage/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/evidence photos/i)).toBeInTheDocument();
  });

  it('shows branch-review confirmation after exception is submitted', async () => {
    rpcMock.mockResolvedValue({ data: 'exc-uuid-0002', error: null });
    mockStopsTable([makeStop()]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /expand stop actions/i }));
    await userEvent.click(screen.getByRole('button', { name: /report exception/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit exception/i }));

    await waitFor(() => {
      expect(screen.getByText(/branch notified for review/i)).toBeInTheDocument();
    });
  });

  // ── Proof-of-delivery evidence summary on completed stops ─────────────────

  it('shows View proof link for completed stops', async () => {
    mockStopsTable([makeStop({ stop_status: 'completed', completed_at: '2026-06-09T10:00:00Z' })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    const proofLink = screen.getByRole('link', { name: /view proof/i });
    expect(proofLink).toHaveAttribute('href', '/field/pod?stop=stop-1');
  });

  it('shows signature confirmation on completed stop with signature', async () => {
    mockStopsTable([
      makeStop({
        stop_status: 'completed',
        completed_at: '2026-06-09T10:00:00Z',
        signature: 'Jane Driver',
      }),
    ]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    expect(screen.getByText(/✓ Signature/i)).toBeInTheDocument();
  });

  it('shows Needs review indicator on completed stop without signature', async () => {
    mockStopsTable([
      makeStop({
        stop_status: 'completed',
        completed_at: '2026-06-09T10:00:00Z',
        signature: null,
      }),
    ]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    expect(screen.getByText(/Needs review/i)).toBeInTheDocument();
    expect(screen.queryByText(/✓ Signature/i)).not.toBeInTheDocument();
  });

  it('shows photo count confirmation on completed stop with photos', async () => {
    mockStopsTable([
      makeStop({
        stop_status: 'completed',
        completed_at: '2026-06-09T10:00:00Z',
        signature: 'Jane Driver',
        photo_paths: ['dispatch-stops/stop-1/photo1.jpg', 'dispatch-stops/stop-1/photo2.jpg'],
      }),
    ]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    expect(screen.getByText(/✓ 2 photos/i)).toBeInTheDocument();
  });

  it('does not show View proof link for non-completed stops', async () => {
    mockStopsTable([makeStop({ stop_status: 'arrived' })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    expect(screen.queryByRole('link', { name: /view proof/i })).not.toBeInTheDocument();
  });

  it('does not show navigate-to-stop link for completed stops', async () => {
    mockStopsTable([makeStop({ stop_status: 'completed', completed_at: '2026-06-09T10:00:00Z' })]);
    render(<DriverDispatchScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });

    // Navigation link is only shown for non-completed stops.
    expect(screen.queryByRole('link', { name: /navigate to stop/i })).not.toBeInTheDocument();
  });
});
