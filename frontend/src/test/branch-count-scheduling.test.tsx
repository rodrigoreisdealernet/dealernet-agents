import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  rpcMock,
  fromMock,
  authState,
} = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  authState: {
    value: {
      profile: { id: 'manager-1', displayName: 'North Manager', role: 'branch_manager' },
      session: { access_token: 'token' },
    },
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
      canWrite: types.canWrite(authState.value.profile?.role as import('@/auth/types').AppRole | undefined),
      canOperate: types.canOperate(authState.value.profile?.role as import('@/auth/types').AppRole | undefined),
      role: authState.value.profile?.role,
    }),
  };
});

import { BranchCountSchedulingScreen } from '@/routes/branch/counts';

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

function createQueryResponse(data: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data, error: null }),
  };
}

describe('RapidCount scheduling screen', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
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
    authState.value = {
      profile: { id: 'manager-1', displayName: 'North Manager', role: 'branch_manager' },
      session: { access_token: 'token' },
    };
  });

  it('renders branch progress, task ownership, and audit history', async () => {
    const branchesQuery = createQueryResponse([
      { entity_id: 'branch-1', name: 'North Yard' },
    ]);
    const tasksQuery = createQueryResponse([
      {
        count_task_id: 'task-1',
        task_name: 'North Yard Weekly Cycle Count',
        status: 'submitted',
        branch_id: 'branch-1',
        branch_name: 'North Yard',
        location_name: 'Aisles A-C',
        assignee_name: 'Casey Counter',
        due_date: '2026-06-20',
        count_type: 'cycle_count',
        schedule_type: 'recurring',
        recurrence_pattern: 'weekly:mon',
        updated_by: 'North Manager',
        updated_at: '2026-06-12T12:00:00Z',
        is_overdue: false,
        description: 'Count high-turn accessories',
      },
    ]);
    const progressQuery = createQueryResponse([
      {
        branch_id: 'branch-1',
        branch_name: 'North Yard',
        total_tasks: 3,
        completed_tasks: 1,
        overdue_tasks: 1,
        planned_tasks: 1,
        in_progress_tasks: 0,
        submitted_tasks: 1,
        approved_tasks: 1,
        closed_tasks: 0,
        completion_pct: 33.3,
      },
    ]);
    const auditQuery = createQueryResponse([
      {
        audit_event_id: 'audit-1',
        count_task_id: 'task-1',
        observed_at: '2026-06-12T12:00:00Z',
        previous_status: 'in_progress',
        status: 'submitted',
        note: 'Submitted branch count',
        actor_name: 'North Manager',
        version_number: 3,
      },
    ]);

    fromMock.mockImplementation((table: string) => {
      if (table === 'rental_current_branches') return branchesQuery;
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_branch_progress') return progressQuery;
      if (table === 'rapidcount_count_task_audit_history') return auditQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    renderWithQueryClient(<BranchCountSchedulingScreen />);

    expect(await screen.findByRole('heading', { name: 'RapidCount Scheduling' })).toBeInTheDocument();
    expect(await screen.findByText('North Yard Weekly Cycle Count')).toBeInTheDocument();
    expect(screen.getByText(/Owner Casey Counter/i)).toBeInTheDocument();
    expect(screen.getByText(/1\/3 complete • 1 overdue/i)).toBeInTheDocument();
    expect(screen.getByText(/in_progress → submitted/i)).toBeInTheDocument();
    expect(screen.getByText(/Submitted branch count/i)).toBeInTheDocument();
  });

  it('creates a recurring count task through the RPC', async () => {
    const branchesQuery = createQueryResponse([
      { entity_id: 'branch-1', name: 'North Yard' },
    ]);
    const emptyTasksQuery = createQueryResponse([]);
    const emptyProgressQuery = createQueryResponse([]);
    const emptyAuditQuery = createQueryResponse([]);

    fromMock.mockImplementation((table: string) => {
      if (table === 'rental_current_branches') return branchesQuery;
      if (table === 'rapidcount_count_tasks_current') return emptyTasksQuery;
      if (table === 'rapidcount_count_branch_progress') return emptyProgressQuery;
      if (table === 'rapidcount_count_task_audit_history') return emptyAuditQuery;
      throw new Error(`Unexpected table ${table}`);
    });
    rpcMock.mockResolvedValue({ data: [{ count_task_id: 'task-2' }], error: null });

    renderWithQueryClient(<BranchCountSchedulingScreen />);

    await screen.findByRole('heading', { name: 'RapidCount Scheduling' });

    await userEvent.type(screen.getByLabelText('Task name'), 'North Yard Weekly Cycle Count');
    await userEvent.click(screen.getByRole('combobox', { name: 'Branch' }));
    await userEvent.click(screen.getByRole('option', { name: 'North Yard' }));
    await userEvent.type(screen.getByLabelText('Location'), 'Aisles A-C');
    await userEvent.type(screen.getByLabelText('Assignee'), 'Casey Counter');
    await userEvent.type(screen.getByLabelText('Due date'), '2026-06-20');
    await userEvent.click(screen.getByRole('combobox', { name: 'Schedule type' }));
    await userEvent.click(screen.getByRole('option', { name: 'Recurring' }));
    await userEvent.type(await screen.findByLabelText('Recurrence pattern'), 'weekly:mon');
    await userEvent.type(screen.getByLabelText('Description'), 'Count high-turn accessories');
    await userEvent.click(screen.getByRole('button', { name: 'Create count task' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rapidcount_create_count_task', {
        p_name: 'North Yard Weekly Cycle Count',
        p_branch_id: 'branch-1',
        p_assignee_name: 'Casey Counter',
        p_due_date: '2026-06-20',
        p_count_type: 'cycle_count',
        p_location_name: 'Aisles A-C',
        p_schedule_type: 'recurring',
        p_recurrence_pattern: 'weekly:mon',
        p_description: 'Count high-turn accessories',
      });
    });
  });

  it('reviews a submitted task variance with explicit reason capture', async () => {
    const branchesQuery = createQueryResponse([
      { entity_id: 'branch-1', name: 'North Yard' },
    ]);
    const tasksQuery = createQueryResponse([
      {
        count_task_id: 'task-1',
        task_name: 'North Yard Weekly Cycle Count',
        status: 'submitted',
        branch_id: 'branch-1',
        branch_name: 'North Yard',
        location_name: 'Aisles A-C',
        assignee_name: 'Casey Counter',
        due_date: '2026-06-20',
        count_type: 'cycle_count',
        schedule_type: 'recurring',
        recurrence_pattern: 'weekly:mon',
        updated_by: 'North Manager',
        updated_at: '2026-06-12T12:00:00Z',
        is_overdue: false,
      },
    ]);
    const progressQuery = createQueryResponse([
      {
        branch_id: 'branch-1',
        branch_name: 'North Yard',
        total_tasks: 1,
        completed_tasks: 0,
        overdue_tasks: 0,
        planned_tasks: 0,
        in_progress_tasks: 0,
        submitted_tasks: 1,
        approved_tasks: 0,
        closed_tasks: 0,
        completion_pct: 0,
      },
    ]);
    const auditQuery = createQueryResponse([]);

    fromMock.mockImplementation((table: string) => {
      if (table === 'rental_current_branches') return branchesQuery;
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_branch_progress') return progressQuery;
      if (table === 'rapidcount_count_task_audit_history') return auditQuery;
      throw new Error(`Unexpected table ${table}`);
    });
    rpcMock.mockResolvedValue({ data: [{ count_task_id: 'task-1' }], error: null });

    renderWithQueryClient(<BranchCountSchedulingScreen />);

    await screen.findByText('North Yard Weekly Cycle Count');
    await userEvent.type(
      screen.getByLabelText('Variance review reason'),
      'Validated against on-hand records and approve adjustment.'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve Variance' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rapidcount_review_count_variances', {
        p_count_task_id: 'task-1',
        p_decision: 'approve',
        p_reason: 'Validated against on-hand records and approve adjustment.',
      });
    });
  });

  it('blocks submitted variance review when no reason is provided', async () => {
    const branchesQuery = createQueryResponse([
      { entity_id: 'branch-1', name: 'North Yard' },
    ]);
    const tasksQuery = createQueryResponse([
      {
        count_task_id: 'task-1',
        task_name: 'North Yard Weekly Cycle Count',
        status: 'submitted',
        branch_id: 'branch-1',
        branch_name: 'North Yard',
        location_name: 'Aisles A-C',
        assignee_name: 'Casey Counter',
        due_date: '2026-06-20',
        count_type: 'cycle_count',
        schedule_type: 'recurring',
        recurrence_pattern: 'weekly:mon',
        updated_by: 'North Manager',
        updated_at: '2026-06-12T12:00:00Z',
        is_overdue: false,
      },
    ]);
    const progressQuery = createQueryResponse([
      {
        branch_id: 'branch-1',
        branch_name: 'North Yard',
        total_tasks: 1,
        completed_tasks: 0,
        overdue_tasks: 0,
        planned_tasks: 0,
        in_progress_tasks: 0,
        submitted_tasks: 1,
        approved_tasks: 0,
        closed_tasks: 0,
        completion_pct: 0,
      },
    ]);
    const auditQuery = createQueryResponse([]);

    fromMock.mockImplementation((table: string) => {
      if (table === 'rental_current_branches') return branchesQuery;
      if (table === 'rapidcount_count_tasks_current') return tasksQuery;
      if (table === 'rapidcount_count_branch_progress') return progressQuery;
      if (table === 'rapidcount_count_task_audit_history') return auditQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    renderWithQueryClient(<BranchCountSchedulingScreen />);

    await screen.findByText('North Yard Weekly Cycle Count');
    await userEvent.click(screen.getByRole('button', { name: 'Approve Variance' }));

    expect(await screen.findByText(/A review reason is required/i)).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalledWith(
      'rapidcount_review_count_variances',
      expect.objectContaining({ p_count_task_id: 'task-1' })
    );
  });
});
