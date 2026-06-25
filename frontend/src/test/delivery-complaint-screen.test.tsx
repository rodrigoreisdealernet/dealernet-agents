import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before any module resolution.
// ---------------------------------------------------------------------------

const { fromMock, useAuthMock, useSearchMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  useAuthMock: vi.fn(),
  useSearchMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: { from: fromMock },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: useAuthMock,
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => (opts: { component: unknown }) => opts,
    useSearch: useSearchMock,
  };
});

import { DeliveryComplaintsScreen } from '@/routes/dispatch/complaints';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown[] | null; error: null | { message: string } }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'eq']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (
    resolve: (v: typeof result) => unknown,
    reject?: (r: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeComplaintRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    case_id: 'case-uuid-001',
    stop_id: 'stop-uuid-001',
    complaint_type: 'late_delivery',
    complaint_narrative: 'Customer called — delivery was 3 hours late.',
    recovery_action: 'branch_follow_up',
    recovery_owner: 'Market Logistics Dispatcher',
    evidence_status: 'ambiguous',
    requires_human_review: true,
    case_created_at: '2026-06-17T10:00:00Z',
    case_updated_at: '2026-06-17T10:15:00Z',
    stop_type: 'delivery',
    stop_status: 'completed',
    customer_name: 'Acme Construction',
    job_site_name: 'Acme Site A',
    address: '100 Main St',
    contract_line_id: 'line-uuid-001',
    asset_id: 'asset-abc',
    stop_notes: 'Customer requested morning delivery window.',
    departed_at: '2026-06-17T07:00:00Z',
    arrived_at: '2026-06-17T10:00:00Z',
    stop_completed_at: '2026-06-17T10:15:00Z',
    route_id: 'route-uuid-001',
    route_date: '2026-06-17',
    route_status: 'completed',
    pod_evidence_status: 'needs_review',
    pod_signature: null,
    pod_photo_paths: [],
    pod_condition_notes: null,
    pod_completed_at: '2026-06-17T10:20:00Z',
    open_exception_count: 1,
    ...overrides,
  };
}

function mockManagerRole() {
  useAuthMock.mockReturnValue({ profile: { role: 'branch_manager' } });
  useSearchMock.mockReturnValue({});
}

function mockAdminRole() {
  useAuthMock.mockReturnValue({ profile: { role: 'admin' } });
  useSearchMock.mockReturnValue({});
}

function mockReadOnlyRole() {
  useAuthMock.mockReturnValue({ profile: { role: 'read_only' } });
  useSearchMock.mockReturnValue({});
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('DeliveryComplaintsScreen — access control', () => {
  it('shows access denied for read_only role', () => {
    mockReadOnlyRole();
    render(<DeliveryComplaintsScreen />);
    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
    expect(screen.queryByTestId('complaints-heading')).not.toBeInTheDocument();
  });

  it('renders the complaint queue heading for branch_manager', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({ data: [], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaints-heading')).toBeInTheDocument();
    });
  });

  it('renders the complaint queue heading for admin', async () => {
    mockAdminRole();
    fromMock.mockReturnValue(makeChain({ data: [], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaints-heading')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('DeliveryComplaintsScreen — empty state', () => {
  it('shows no-complaints empty state when the queue is empty', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({ data: [], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaints-empty')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe('DeliveryComplaintsScreen — error handling', () => {
  it('shows an error alert when data loading fails', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({ data: null, error: { message: 'DB timeout' } }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaints-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/DB timeout/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Case list rendering
// ---------------------------------------------------------------------------

describe('DeliveryComplaintsScreen — case list', () => {
  beforeEach(() => {
    mockManagerRole();
  });

  it('renders a complaint case card with customer name and type', async () => {
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaint-case-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('case-title')).toHaveTextContent(/late delivery/i);
    expect(screen.getByText('Acme Construction')).toBeInTheDocument();
  });

  it('shows the evidence status badge for an ambiguous case', async () => {
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('badge-ambiguous')).toBeInTheDocument();
    });
  });

  it('shows the evidence status badge for a packaged case', async () => {
    fromMock.mockReturnValue(makeChain({
      data: [makeComplaintRow({
        evidence_status: 'packaged',
        pod_evidence_status: 'complete',
        pod_signature: 'J. Smith',
        pod_photo_paths: ['photo1.jpg'],
        open_exception_count: 0,
      })],
      error: null,
    }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('badge-packaged')).toBeInTheDocument();
    });
  });

  it('shows the evidence status badge for an incomplete case', async () => {
    fromMock.mockReturnValue(makeChain({
      data: [makeComplaintRow({
        evidence_status: 'incomplete',
        stop_id: '',
      })],
      error: null,
    }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('badge-incomplete')).toBeInTheDocument();
    });
  });

  it('shows human approval required badge', async () => {
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('badge-human-review')).toBeInTheDocument();
    });
  });

  it('shows the proposed recovery section', async () => {
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-proposal')).toBeInTheDocument();
    });
    expect(screen.getByText(/branch follow-up required/i)).toBeInTheDocument();
  });

  it('shows the complaint narrative when present', async () => {
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaint-narrative')).toBeInTheDocument();
    });
    expect(screen.getByText(/delivery was 3 hours late/i)).toBeInTheDocument();
  });

  it('shows open exception indicator when open exceptions exist', async () => {
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow({ open_exception_count: 2 })], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('open-exceptions')).toBeInTheDocument();
    });
    expect(screen.getByText(/2 open exceptions/i)).toBeInTheDocument();
  });

  it('does not show open exception indicator when there are no open exceptions', async () => {
    fromMock.mockReturnValue(makeChain({
      data: [makeComplaintRow({
        open_exception_count: 0,
        evidence_status: 'packaged',
        pod_evidence_status: 'complete',
        pod_signature: 'J. Smith',
      })],
      error: null,
    }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaint-case-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('open-exceptions')).not.toBeInTheDocument();
  });

  it('shows recommendation text', async () => {
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('recommendation')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Evidence bundle — expand / collapse
// ---------------------------------------------------------------------------

describe('DeliveryComplaintsScreen — evidence bundle', () => {
  it('evidence bundle is hidden by default and expands on click', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);

    await waitFor(() => {
      expect(screen.getByText(/show evidence bundle/i)).toBeInTheDocument();
    });

    expect(screen.queryByTestId('evidence-bundle')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText(/show evidence bundle/i));

    expect(screen.getByTestId('evidence-bundle')).toBeInTheDocument();
    expect(screen.getByText(/stop timeline/i)).toBeInTheDocument();
  });

  it('collapses evidence bundle after a second click', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);

    await waitFor(() => {
      expect(screen.getByText(/show evidence bundle/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/show evidence bundle/i));
    expect(screen.getByTestId('evidence-bundle')).toBeInTheDocument();

    await userEvent.click(screen.getByText(/hide evidence bundle/i));
    expect(screen.queryByTestId('evidence-bundle')).not.toBeInTheDocument();
  });

  it('shows branch / stop notes in the evidence bundle when stop_notes is present', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({
      data: [makeComplaintRow({ stop_notes: 'Customer requested morning delivery window.' })],
      error: null,
    }));
    render(<DeliveryComplaintsScreen />);

    await waitFor(() => {
      expect(screen.getByText(/show evidence bundle/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/show evidence bundle/i));

    expect(screen.getByTestId('evidence-bundle')).toBeInTheDocument();
    expect(screen.getByText(/branch \/ stop notes/i)).toBeInTheDocument();
    expect(screen.getByText(/morning delivery window/i)).toBeInTheDocument();
  });

  it('does not show branch notes evidence item when stop_notes is absent', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({
      data: [makeComplaintRow({ stop_notes: null })],
      error: null,
    }));
    render(<DeliveryComplaintsScreen />);

    await waitFor(() => {
      expect(screen.getByText(/show evidence bundle/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/show evidence bundle/i));

    expect(screen.getByTestId('evidence-bundle')).toBeInTheDocument();
    expect(screen.queryByText(/branch \/ stop notes/i)).not.toBeInTheDocument();
  });

  it('shows the POD completion time from pod_completed_at, not stop_completed_at', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({
      data: [makeComplaintRow({
        evidence_status: 'packaged',
        pod_evidence_status: 'complete',
        pod_signature: 'J. Smith',
        pod_photo_paths: ['photo1.jpg'],
        pod_condition_notes: 'Good condition.',
        // Deliberately different timestamps so we can assert the right one is used.
        pod_completed_at: '2026-06-17T10:20:00Z',
        stop_completed_at: '2026-06-17T10:15:00Z',
        open_exception_count: 0,
      })],
      error: null,
    }));
    render(<DeliveryComplaintsScreen />);

    await waitFor(() => {
      expect(screen.getByText(/show evidence bundle/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/show evidence bundle/i));

    const bundle = screen.getByTestId('evidence-bundle');
    expect(bundle).toBeInTheDocument();
    // Scope within the bundle to avoid matching the page header description.
    const podLabels = within(bundle).getAllByText(/proof-of-delivery evidence/i);
    expect(podLabels.length).toBeGreaterThan(0);
    // Get the container div for the POD evidence item.
    const podItem = podLabels[0].closest('div');
    expect(podItem).toBeTruthy();
    // POD completion time (10:20 from pod_completed_at) must appear.
    expect(podItem!.textContent).toContain('10:20');
    // Stop completion time (10:15 from stop_completed_at) must NOT appear in the POD item.
    expect(podItem!.textContent).not.toContain('10:15');
  });
});

// ---------------------------------------------------------------------------
// Refresh button
// ---------------------------------------------------------------------------

describe('DeliveryComplaintsScreen — refresh', () => {
  it('refresh button triggers data reload', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({ data: [], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaints-empty')).toBeInTheDocument();
    });

    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    await userEvent.click(screen.getByTestId('refresh-button'));

    await waitFor(() => {
      expect(screen.getByTestId('complaint-case-list')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Stop-level filter (search param)
// ---------------------------------------------------------------------------

describe('DeliveryComplaintsScreen — stop filter', () => {
  it('shows filter indicator when ?stop= param is set', async () => {
    useAuthMock.mockReturnValue({ profile: { role: 'branch_manager' } });
    useSearchMock.mockReturnValue({ stop: 'stop-uuid-001' });
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByText(/Showing complaint cases for stop/i)).toBeInTheDocument();
    });
  });

  it('hides cases for unmatched stop when filter is set', async () => {
    useAuthMock.mockReturnValue({ profile: { role: 'branch_manager' } });
    useSearchMock.mockReturnValue({ stop: 'stop-uuid-OTHER' });
    fromMock.mockReturnValue(makeChain({ data: [makeComplaintRow()], error: null }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('complaints-empty')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Multiple cases
// ---------------------------------------------------------------------------

describe('DeliveryComplaintsScreen — multiple cases', () => {
  it('renders a count when multiple cases exist', async () => {
    mockManagerRole();
    fromMock.mockReturnValue(makeChain({
      data: [
        makeComplaintRow({ case_id: 'case-1' }),
        makeComplaintRow({ case_id: 'case-2', complaint_type: 'missed_pickup', customer_name: 'Beta Corp' }),
      ],
      error: null,
    }));
    render(<DeliveryComplaintsScreen />);
    await waitFor(() => {
      expect(screen.getByText(/2 open complaint cases/i)).toBeInTheDocument();
    });
  });
});
