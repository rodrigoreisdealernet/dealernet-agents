import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock supabase
// ---------------------------------------------------------------------------

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
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
    rpc: rpcMock,
  },
}));

// TanStack Router useSearch mock: default to stop=stop-uuid-0001
const searchParams: Record<string, string | undefined> = { stop: 'stop-uuid-0001' };

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...original,
    createFileRoute: () => (opts: { component: unknown }) => opts,
    useSearch: () => searchParams,
  };
});

import { StopPodScreen, loadStopPod } from '@/routes/field/pod';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makePodRow(overrides: Record<string, unknown> = {}) {
  return {
    stop_id: 'stop-uuid-0001',
    stop_type: 'delivery',
    customer_name: 'Acme Construction',
    job_site_name: 'Site Alpha',
    address: '1 Main St, Anytown',
    contract_line_id: 'line-uuid-0001',
    asset_id: 'EXC-TRX-42001',
    signature: 'Jane Driver',
    condition_notes: 'No damage found',
    photo_paths: ['dispatch-stops/stop-1/photo1.jpg'],
    completed_at: '2026-06-09T10:00:00Z',
    evidence_status: 'complete',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadStopPod unit tests
// ---------------------------------------------------------------------------

describe('loadStopPod', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('maps RPC response to PodBundle', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    const bundle = await loadStopPod('stop-uuid-0001');
    expect(bundle).not.toBeNull();
    expect(bundle!.stopId).toBe('stop-uuid-0001');
    expect(bundle!.stopType).toBe('delivery');
    expect(bundle!.customerName).toBe('Acme Construction');
    expect(bundle!.signature).toBe('Jane Driver');
    expect(bundle!.photoPaths).toHaveLength(1);
    expect(bundle!.evidenceStatus).toBe('complete');
  });

  it('returns null when RPC returns no data (stop not yet completed)', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const bundle = await loadStopPod('stop-uuid-missing');
    expect(bundle).toBeNull();
  });

  it('throws on RPC error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Access denied' } });
    await expect(loadStopPod('stop-uuid-0001')).rejects.toMatchObject({ message: 'Access denied' });
  });

  it('maps pickup stop correctly', async () => {
    rpcMock.mockResolvedValue({
      data: makePodRow({ stop_type: 'pickup', signature: null, evidence_status: 'needs_review' }),
      error: null,
    });
    const bundle = await loadStopPod('stop-uuid-0001');
    expect(bundle!.stopType).toBe('pickup');
    expect(bundle!.signature).toBeNull();
    expect(bundle!.evidenceStatus).toBe('needs_review');
  });

  it('calls get_stop_pod RPC with the correct stop_id', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    await loadStopPod('stop-uuid-0001');
    expect(rpcMock).toHaveBeenCalledWith('get_stop_pod', { p_stop_id: 'stop-uuid-0001' });
  });
});

// ---------------------------------------------------------------------------
// StopPodScreen integration tests
// ---------------------------------------------------------------------------

describe('StopPodScreen', () => {
  beforeEach(() => {
    authState.profile = { id: 'driver-uuid-0001', role: 'field_operator' };
    rpcMock.mockReset();
    searchParams.stop = 'stop-uuid-0001';
  });

  it('renders the Stop Proof Record heading', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Stop Proof Record')).toBeInTheDocument();
    });
  });

  it('shows evidence-complete banner for a complete bundle', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow({ evidence_status: 'complete' }), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Evidence complete')).toBeInTheDocument();
    });
    expect(screen.queryByText('Needs review')).not.toBeInTheDocument();
  });

  it('shows needs-review banner when evidence is incomplete', async () => {
    rpcMock.mockResolvedValue({
      data: makePodRow({ evidence_status: 'needs_review', signature: null }),
      error: null,
    });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Needs review')).toBeInTheDocument();
    });
    expect(screen.queryByText('Evidence complete')).not.toBeInTheDocument();
  });

  it('shows customer name, job site, and address from context', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
      expect(screen.getByText('Site Alpha')).toBeInTheDocument();
      expect(screen.getByText('1 Main St, Anytown')).toBeInTheDocument();
    });
  });

  it('shows asset ID in the context section', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('EXC-TRX-42001')).toBeInTheDocument();
    });
  });

  it('shows the captured signature', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByLabelText('Captured signature')).toBeInTheDocument();
      expect(screen.getByText('Jane Driver')).toBeInTheDocument();
    });
  });

  it('shows Not captured when signature is absent', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow({ signature: null }), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Not captured')).toBeInTheDocument();
    });
  });

  it('shows condition notes when present', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('No damage found')).toBeInTheDocument();
    });
  });

  it('shows None recorded when condition notes are absent', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow({ condition_notes: null }), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('None recorded')).toBeInTheDocument();
    });
  });

  it('shows photo count when photos are attached', async () => {
    rpcMock.mockResolvedValue({
      data: makePodRow({ photo_paths: ['path/a.jpg', 'path/b.jpg'] }),
      error: null,
    });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText(/2 photos attached/i)).toBeInTheDocument();
    });
  });

  it('shows No photos attached when photo list is empty', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow({ photo_paths: [] }), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText(/No photos attached/i)).toBeInTheDocument();
    });
  });

  it('shows not-found alert when RPC returns null', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Proof record not found')).toBeInTheDocument();
    });
  });

  it('shows not-found alert when no stop param is supplied', async () => {
    searchParams.stop = undefined;
    rpcMock.mockResolvedValue({ data: null, error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Proof record not found')).toBeInTheDocument();
    });
  });

  it('shows load error when RPC call fails', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Connection timeout' } });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Could not load proof record')).toBeInTheDocument();
    });
    expect(screen.getByText('Failed to load proof record.')).toBeInTheDocument();
  });

  it('shows access denied for read_only users', async () => {
    authState.profile = { id: 'readonly-uuid', role: 'read_only' };
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Access denied')).toBeInTheDocument();
    });
    // RPC should not have been called for unauthorised users.
    expect(rpcMock).not.toHaveBeenCalled();
  });

  // ── Delivery vs. pickup rendering ──────────────────────────────────────────

  it('shows Delivery badge for delivery stop type', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow({ stop_type: 'delivery' }), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Delivery')).toBeInTheDocument();
    });
  });

  it('shows Pickup badge for pickup stop type', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow({ stop_type: 'pickup' }), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Pickup')).toBeInTheDocument();
    });
  });

  // ── Authorization: no fleet/route/driver data exposed ─────────────────────

  it('does not expose route or driver identity fields', async () => {
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Stop Proof Record')).toBeInTheDocument();
    });

    // The page must not render route IDs, driver IDs, or fleet telemetry.
    expect(screen.queryByText(/route[-_]id/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/driver[-_]id/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/telemetry/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/eld/i)).not.toBeInTheDocument();
  });

  // ── Branch manager access ─────────────────────────────────────────────────

  it('renders for branch_manager role', async () => {
    authState.profile = { id: 'manager-uuid', role: 'branch_manager' };
    rpcMock.mockResolvedValue({ data: makePodRow(), error: null });
    render(<StopPodScreen />);
    await waitFor(() => {
      expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    });
  });
});
