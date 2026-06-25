import type { ReactElement } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const { rpcMock, fromMock, authState } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  authState: {
    value: {
      profile: {
        id: 'operator-1',
        displayName: 'Casey Counter',
        email: 'casey@example.com',
        role: 'field_operator' as 'admin' | 'branch_manager' | 'field_operator' | 'read_only',
        tenant: 'default',
      },
      session: { access_token: 'token' },
    } as {
      profile: {
        id: string;
        displayName: string;
        email: string;
        role: 'admin' | 'branch_manager' | 'field_operator' | 'read_only';
        tenant: string;
      };
      session: { access_token: string };
    } | { profile: null; session: null },
  },
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
  },
}));

vi.mock('@/auth/AuthContext', async () => {
  const types = await vi.importActual<typeof import('@/auth/types')>('@/auth/types');
  return {
    useAuth: () => authState.value,
    useAuthCapabilities: () => ({
      canWrite: types.canWrite(
        (authState.value as { profile: { role: string } | null }).profile?.role as
          | import('@/auth/types').AppRole
          | undefined,
      ),
      canOperate: types.canOperate(
        (authState.value as { profile: { role: string } | null }).profile?.role as
          | import('@/auth/types').AppRole
          | undefined,
      ),
      role: (authState.value as { profile: { role: string } | null }).profile?.role,
    }),
  };
});

import { RapidCountCaptureScreen } from '@/routes/field/counts';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function createTableQuery(data: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data, error: null }),
  };
}

const TASK_PLANNED = {
  count_task_id: 'task-1',
  task_name: 'North Yard Weekly Count',
  description: 'Count high-turn accessories',
  status: 'planned',
  branch_id: 'branch-1',
  branch_name: 'North Yard',
  location_name: 'Aisles A-C',
  assignee_name: 'Casey Counter',
  due_date: '2026-06-20',
  count_type: 'cycle_count',
  schedule_type: 'recurring',
  recurrence_pattern: 'weekly:mon',
  updated_by: null,
  updated_at: null,
  is_overdue: false,
};

const TASK_IN_PROGRESS = { ...TASK_PLANNED, status: 'in_progress' };

describe('RapidCount mobile capture screen', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    localStorage.clear();
    authState.value = {
      profile: {
        id: 'operator-1',
        displayName: 'Casey Counter',
        email: 'casey@example.com',
        role: 'field_operator',
        tenant: 'default',
      },
      session: { access_token: 'token' },
    };
    Object.defineProperty(window, 'navigator', {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the page heading', async () => {
    fromMock.mockImplementation(() => createTableQuery([]));
    renderWithQueryClient(<RapidCountCaptureScreen />);
    expect(await screen.findByRole('heading', { name: 'RapidCount Capture' })).toBeInTheDocument();
  });

  it('shows RFID unsupported banner in browser runtime', async () => {
    fromMock.mockImplementation(() => createTableQuery([]));
    renderWithQueryClient(<RapidCountCaptureScreen />);
    expect(await screen.findByText('RFID scanning unavailable')).toBeInTheDocument();
    expect(
      screen.getByText(/Use barcode scanning or manual entry in this browser session/),
    ).toBeInTheDocument();
  });

  it('shows empty state when no tasks are assigned to the user', async () => {
    fromMock.mockImplementation(() => createTableQuery([]));
    renderWithQueryClient(<RapidCountCaptureScreen />);
    expect(
      await screen.findByText(/No count tasks are currently assigned to you/),
    ).toBeInTheDocument();
  });

  it('shows only tasks assigned to the current user', async () => {
    const tasksQuery = createTableQuery([
      TASK_PLANNED,
      { ...TASK_PLANNED, count_task_id: 'task-other', assignee_name: 'Other Counter', task_name: 'Other Task' },
    ]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return createTableQuery([]);
      throw new Error(`Unexpected table: ${table}`);
    });
    renderWithQueryClient(<RapidCountCaptureScreen />);
    expect(await screen.findByText('North Yard Weekly Count')).toBeInTheDocument();
    expect(screen.queryByText('Other Task')).not.toBeInTheDocument();
  });

  it('shows access denied for read_only users', async () => {
    authState.value = {
      profile: {
        id: 'readonly-1',
        displayName: 'Read Only',
        email: 'ro@example.com',
        role: 'read_only',
        tenant: 'default',
      },
      session: { access_token: 'token' },
    };
    fromMock.mockImplementation(() => createTableQuery([]));
    renderWithQueryClient(<RapidCountCaptureScreen />);
    expect(await screen.findByText('Access restricted')).toBeInTheDocument();
  });

  it('starts a planned task when "Start counting" is clicked', async () => {
    const tasksQuery = createTableQuery([TASK_PLANNED]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });
    rpcMock.mockResolvedValue({ data: [{ count_task_id: 'task-1', version_number: 2 }], error: null });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    const startBtn = await screen.findByRole('button', { name: 'Start counting' });
    await userEvent.click(startBtn);

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rapidcount_start_count_task', {
        p_count_task_id: 'task-1',
      });
    });

    expect(await screen.findByText('Active task')).toBeInTheDocument();
  });

  it('enters capture mode directly for in_progress tasks', async () => {
    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    const continueBtn = await screen.findByRole('button', { name: 'Continue counting' });
    await userEvent.click(continueBtn);

    expect(rpcMock).not.toHaveBeenCalledWith(
      'rapidcount_start_count_task',
      expect.anything(),
    );
    expect(await screen.findByText('Active task')).toBeInTheDocument();
  });

  it('captures a count line via barcode when online', async () => {
    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });
    rpcMock.mockResolvedValue({
      data: [{ line_id: 'line-1', captured_at: '2026-06-13T02:00:00Z' }],
      error: null,
    });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue counting' }));
    await screen.findByText('Active task');

    await userEvent.type(screen.getByLabelText('Barcode / scan value'), 'PART-12345');
    await userEvent.clear(screen.getByLabelText('Quantity'));
    await userEvent.type(screen.getByLabelText('Quantity'), '3');
    await userEvent.type(screen.getByLabelText('Description (optional)'), 'Widget A');
    await userEvent.click(screen.getByRole('button', { name: 'Capture item' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rapidcount_capture_count_line',
        expect.objectContaining({
          p_count_task_id: 'task-1',
          p_scan_value: 'PART-12345',
          p_scan_method: 'barcode',
          p_quantity: 3,
          p_item_description: 'Widget A',
        }),
      );
    });
  });

  it('stages capture to offline queue when navigator.onLine is false', async () => {
    Object.defineProperty(window, 'navigator', {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue counting' }));
    await screen.findByText('Active task');

    // Offline banner should be visible.
    expect(screen.getByText('You are offline')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Barcode / scan value'), 'PART-99999');
    await userEvent.click(screen.getByRole('button', { name: 'Stage offline' }));

    // RPC should NOT have been called; item staged in local queue.
    expect(rpcMock).not.toHaveBeenCalledWith(
      'rapidcount_capture_count_line',
      expect.anything(),
    );

    const stored = JSON.parse(localStorage.getItem('rapidcount_offline_queue') ?? '[]') as Array<{
      scan_value: string;
      status: string;
    }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].scan_value).toBe('PART-99999');
    expect(stored[0].status).toBe('pending');
  });

  it('replays offline queue when connectivity returns', async () => {
    // Pre-seed the local queue with one pending item.
    const pending = [
      {
        idempotency_key: 'idem-1',
        count_task_id: 'task-1',
        scan_value: 'PART-QUEUED',
        scan_method: 'barcode',
        quantity: 2,
        item_description: '',
        queued_at: '2026-06-13T01:55:00Z',
        attempt_at: null,
        status: 'pending',
        error: null,
      },
    ];
    localStorage.setItem('rapidcount_offline_queue', JSON.stringify(pending));

    // Start offline so the component initialises with isOnline=false; the
    // online event below will flip the state and trigger auto-replay.
    Object.defineProperty(window, 'navigator', {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });
    rpcMock.mockResolvedValue({ data: [{ line_id: 'line-q' }], error: null });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await screen.findByRole('heading', { name: 'RapidCount Capture' });

    // Transition from offline → online to trigger auto-replay.
    await act(async () => {
      Object.defineProperty(window, 'navigator', {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rapidcount_capture_count_line',
        expect.objectContaining({
          p_idempotency_key: 'idem-1',
          p_scan_value: 'PART-QUEUED',
        }),
      );
    });

    // After sync, the item should be removed from the persistent queue.
    const remaining = JSON.parse(
      localStorage.getItem('rapidcount_offline_queue') ?? '[]',
    ) as unknown[];
    expect(remaining).toHaveLength(0);
  });

  it('shows sync failure state when offline replay fails', async () => {
    const pending = [
      {
        idempotency_key: 'idem-fail',
        count_task_id: 'task-1',
        scan_value: 'PART-FAIL',
        scan_method: 'manual',
        quantity: 1,
        item_description: '',
        queued_at: '2026-06-13T01:55:00Z',
        attempt_at: null,
        status: 'pending',
        error: null,
      },
    ];
    localStorage.setItem('rapidcount_offline_queue', JSON.stringify(pending));

    // Start offline so the online event below actually changes state.
    Object.defineProperty(window, 'navigator', {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Server error' } });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await screen.findByRole('heading', { name: 'RapidCount Capture' });

    await act(async () => {
      Object.defineProperty(window, 'navigator', {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(screen.getByText('Sync failure')).toBeInTheDocument();
    });

    expect(screen.getByText(/item\(s\) could not be synced/)).toBeInTheDocument();
  });

  it('shows captured lines after successful capture', async () => {
    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const capturedLine = {
      line_id: 'line-1',
      count_task_id: 'task-1',
      captured_at: '2026-06-13T02:00:00Z',
      scan_value: 'PART-12345',
      scan_method: 'barcode',
      quantity: 2,
      item_description: 'Widget A',
      captured_by: 'Casey Counter',
      idempotency_key: 'idem-abc',
    };
    let lineFetchCount = 0;
    const linesQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockImplementation(() => {
        lineFetchCount++;
        if (lineFetchCount > 1) {
          return Promise.resolve({ data: [capturedLine], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      }),
    };
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });
    rpcMock.mockResolvedValue({
      data: [{ line_id: 'line-1', captured_at: '2026-06-13T02:00:00Z' }],
      error: null,
    });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue counting' }));
    await screen.findByText('Active task');

    await userEvent.type(screen.getByLabelText('Barcode / scan value'), 'PART-12345');
    await userEvent.click(screen.getByRole('button', { name: 'Capture item' }));

    await waitFor(() => {
      expect(screen.getByText('PART-12345')).toBeInTheDocument();
    });
    expect(screen.getByText('Widget A')).toBeInTheDocument();
    expect(screen.getByText('×2')).toBeInTheDocument();
  });

  it('validates that scan value is required before capture', async () => {
    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue counting' }));
    await screen.findByText('Active task');

    await userEvent.click(screen.getByRole('button', { name: 'Capture item' }));

    expect(await screen.findByText('Scan value is required')).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalledWith('rapidcount_capture_count_line', expect.anything());
  });

  it('exposes RFID as a scan method option in the capture form', async () => {
    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue counting' }));
    await screen.findByText('Active task');

    await userEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: 'RFID scan' })).toBeInTheDocument();
  });

  it('shows RFID unsupported-device state when RFID method is selected', async () => {
    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue counting' }));
    await screen.findByText('Active task');

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'RFID scan' }));

    expect(await screen.findByText('RFID unavailable in browser')).toBeInTheDocument();
    expect(
      screen.getByText(/Switch to barcode or manual entry/),
    ).toBeInTheDocument();
  });

  it('disables the capture button and does not submit when RFID method is selected', async () => {
    const tasksQuery = createTableQuery([TASK_IN_PROGRESS]);
    const linesQuery = createTableQuery([]);
    fromMock.mockImplementation((table: string) => {
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_lines_current') return linesQuery;
      throw new Error(`Unexpected table: ${table}`);
    });

    renderWithQueryClient(<RapidCountCaptureScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue counting' }));
    await screen.findByText('Active task');

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'RFID scan' }));

    const captureBtn = await screen.findByRole('button', { name: 'Capture item' });
    expect(captureBtn).toBeDisabled();
    expect(rpcMock).not.toHaveBeenCalledWith('rapidcount_capture_count_line', expect.anything());
  });
});
