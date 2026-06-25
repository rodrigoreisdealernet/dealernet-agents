import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
      profile: { id: 'user-1', displayName: 'Admin User', role: 'admin' },
      session: { access_token: 'token' },
    },
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
      <a href={to as string} {...props}>{children}</a>
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
    from: vi.fn(),
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
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
import { CustomerProfileListScreen } from '@/routes/crm/customers/index';
import { CustomerProfileDetailScreen } from '@/routes/crm/customers/$id';

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

/** Minimal customer rows for the list screen */
const cleanCustomer = {
  entity_id: 'cust-1',
  source_record_id: 'SRC-001',
  name: 'Acme Industrial LLC',
  customer_type: 'national',
  tier: 'gold',
  industry: 'heavy_civil',
  balance: 15000,
  credit_limit: 50000,
  payment_issue_flag: 0,
  created_at: '2026-01-01T00:00:00Z',
};

const paymentRiskCustomer = {
  entity_id: 'cust-2',
  source_record_id: 'SRC-002',
  name: 'Summit Arc Steel Services',
  customer_type: 'local',
  tier: 'standard',
  industry: 'industrial_maintenance',
  balance: 8000,
  credit_limit: 5000,
  payment_issue_flag: 1,
  created_at: '2026-01-15T00:00:00Z',
};

/** Minimal profile for the detail screen */
const profileRecord = {
  entity_id: 'cust-1',
  source_record_id: 'SRC-001',
  name: 'Acme Industrial LLC',
  customer_type: 'national',
  tier: 'gold',
  industry: 'heavy_civil',
  hq_address: '123 Main St',
  preferred_payment_method: 'ach',
  preferences: null,
  payment_methods: null,
  balance: 15000,
  credit_limit: 50000,
  avg_days_to_pay: 30,
  payment_issue_flag: 0,
  last_interaction_type: null,
  last_interaction_summary: null,
  entity_version_id: 'ver-1',
  version_number: 1,
  valid_from: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  data: {},
};

function listMockData(customers: Array<Record<string, unknown>> = [cleanCustomer, paymentRiskCustomer]) {
  return {
    data: { customers },
    isLoading: {},
    errors: {},
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  };
}

function detailMockData(profile: Record<string, unknown> = profileRecord) {
  return {
    data: {
      profile,
      contacts: [],
      notes: [],
      documents: [],
      billing_accounts: [],
      issues: [],
      communication_timeline: [],
      versions: [],
    },
    isLoading: { profile: false },
    errors: {},
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  };
}

// ─── Customer Profile List ────────────────────────────────────────────────────

describe('CRM customer profile list screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    useDataSourcesMock.mockReset();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Admin User', role: 'admin' },
      session: { access_token: 'token' },
    };
    rpcMock.mockResolvedValue({ data: null, error: null });
  });

  it('renders the Customer Profiles heading', () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByRole('heading', { name: 'Customer Profiles' })).toBeInTheDocument();
  });

  it('shows Create Customer button for write-capable users (admin)', () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByRole('button', { name: 'Create Customer' })).toBeInTheDocument();
  });

  it('hides Create Customer button for read_only users', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Read Only', role: 'read_only' },
      session: { access_token: 'token' },
    };
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.queryByRole('button', { name: 'Create Customer' })).not.toBeInTheDocument();
  });

  it('shows Create Customer button for branch_manager users', () => {
    authState.value = {
      profile: { id: 'user-bm', displayName: 'Branch Manager', role: 'branch_manager' },
      session: { access_token: 'token' },
    };
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByRole('button', { name: 'Create Customer' })).toBeInTheDocument();
  });

  it('opens Create Customer modal and submits RPC with a valid UUID as p_source_record_id', async () => {
    const refetchMock = vi.fn();
    useDataSourcesMock.mockReturnValue({
      ...listMockData(),
      refetch: refetchMock,
    });
    renderWithQueryClient(<CustomerProfileListScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Create Customer' }));

    // Modal should appear
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Customer Name'), 'New Test Corp');

    await userEvent.click(
      screen.getAllByRole('button', { name: 'Create Customer' }).find(
        (btn) => btn.closest('[role="dialog"]') !== null
      )!
    );

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'crm_upsert_customer_profile',
        expect.objectContaining({
          p_source_record_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          ),
          p_data: expect.objectContaining({
            name: 'New Test Corp',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('customers');
    });
  });

  it('shows a validation error when Create Customer is submitted with an empty name', async () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Create Customer' }));

    // Click submit without entering a name
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Create Customer' }).find(
        (btn) => btn.closest('[role="dialog"]') !== null
      )!
    );

    await waitFor(() => {
      expect(screen.getByText('Customer name is required.')).toBeInTheDocument();
    });

    // RPC should not be called
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('shows Open Issue escalation button on payment-risk rows', () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByRole('button', { name: 'Open Issue' })).toBeInTheDocument();
  });

  it('does not show Open Issue button on rows without a payment issue', () => {
    useDataSourcesMock.mockReturnValue(listMockData([cleanCustomer]));
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.queryByRole('button', { name: 'Open Issue' })).not.toBeInTheDocument();
  });

  it('navigates to customer detail when Open Issue is clicked', async () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Open Issue' }));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/crm/customers/cust-2' })
      );
    });
  });

  it('renders customer name as the primary text for each row (not a raw UUID)', () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByText('Acme Industrial LLC')).toBeInTheDocument();
    expect(screen.getByText('Summit Arc Steel Services')).toBeInTheDocument();
  });

  it('shows Industry context in each customer row', () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    // Each row renders "Industry: <value> · Balance: $<amount>"
    expect(screen.getByText(/Industry:\s*heavy_civil/)).toBeInTheDocument();
    expect(screen.getByText(/Industry:\s*industrial_maintenance/)).toBeInTheDocument();
  });

  it('shows Balance as a dollar amount in each customer row', () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByText(/Balance:\s*\$15000/)).toBeInTheDocument();
    expect(screen.getByText(/Balance:\s*\$8000/)).toBeInTheDocument();
  });

  it('shows "Industry: N/A" when industry is null', () => {
    useDataSourcesMock.mockReturnValue(
      listMockData([{ ...cleanCustomer, industry: null }])
    );
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByText(/Industry:\s*N\/A/)).toBeInTheDocument();
  });

  it('shows "Industry: N/A" when industry is an empty string', () => {
    useDataSourcesMock.mockReturnValue(
      listMockData([{ ...cleanCustomer, industry: '' }])
    );
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByText(/Industry:\s*N\/A/)).toBeInTheDocument();
  });

  it('shows "Balance: $0" when balance is null', () => {
    useDataSourcesMock.mockReturnValue(
      listMockData([{ ...cleanCustomer, balance: null }])
    );
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByText(/Balance:\s*\$0/)).toBeInTheDocument();
  });

  it('shows a View Profile button for every customer row', () => {
    useDataSourcesMock.mockReturnValue(listMockData());
    renderWithQueryClient(<CustomerProfileListScreen />);
    const viewProfileButtons = screen.getAllByRole('button', { name: 'View Profile' });
    expect(viewProfileButtons).toHaveLength(2);
  });

  it('navigates to customer detail when View Profile is clicked', async () => {
    useDataSourcesMock.mockReturnValue(listMockData([cleanCustomer]));
    renderWithQueryClient(<CustomerProfileListScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'View Profile' }));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/crm/customers/cust-1' })
      );
    });
  });

  it('renders Payment Issue badge when payment_issue_flag arrives as numeric string after reload', () => {
    useDataSourcesMock.mockReturnValue(
      listMockData([{ ...paymentRiskCustomer, payment_issue_flag: '1' }])
    );
    renderWithQueryClient(<CustomerProfileListScreen />);
    expect(screen.getByText('Payment Issue')).toBeInTheDocument();
  });
});

// ─── Customer Profile Detail ──────────────────────────────────────────────────

describe('CRM customer profile detail screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    useDataSourcesMock.mockReset();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Admin User', role: 'admin' },
      session: { access_token: 'token' },
    };
    rpcMock.mockResolvedValue({ data: null, error: null });
  });

  it('renders the customer name heading', () => {
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByRole('heading', { name: 'Acme Industrial LLC' })).toBeInTheDocument();
  });

  it('shows Log Interaction button for operate-capable users (admin)', () => {
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByRole('button', { name: 'Log Interaction' })).toBeInTheDocument();
  });

  it('hides Log Interaction button for read_only users', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Read Only', role: 'read_only' },
      session: { access_token: 'token' },
    };
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.queryByRole('button', { name: 'Log Interaction' })).not.toBeInTheDocument();
  });

  it('shows Log Interaction button for field_operator users', () => {
    authState.value = {
      profile: { id: 'user-fo', displayName: 'Field Op', role: 'field_operator' },
      session: { access_token: 'token' },
    };
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByRole('button', { name: 'Log Interaction' })).toBeInTheDocument();
  });

  it('opens Log Interaction modal and submits RPC with p_enrich_only: true', async () => {
    const refetchMock = vi.fn();
    useDataSourcesMock.mockReturnValue({
      ...detailMockData(),
      refetch: refetchMock,
    });
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Log Interaction' }));

    // Modal should appear
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Summary'), 'Discussed Q3 renewal terms');

    await userEvent.click(
      screen.getAllByRole('button', { name: 'Log Interaction' }).find(
        (btn) => btn.closest('[role="dialog"]') !== null
      )!
    );

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'crm_upsert_customer_profile',
        expect.objectContaining({
          p_source_record_id: 'SRC-001',
          p_data: expect.objectContaining({
            name: 'Acme Industrial LLC',
            last_interaction_summary: 'Discussed Q3 renewal terms',
          }),
          p_enrich_only: true,
        })
      );
    });
  });

  it('renders the latest profile interaction summary when timeline events are stale', () => {
    const staleTimelineData = detailMockData({
      ...profileRecord,
      last_interaction_type: 'email',
      last_interaction_summary: 'Latest profile interaction summary',
    });
    staleTimelineData.data.communication_timeline = [
      {
        timeline_event_id: 'timeline-older',
        customer_id: 'cust-1',
        billing_account_id: null,
        occurred_at: '2026-01-02T00:00:00Z',
        interaction_type: 'customer_call_logged',
        interaction_label: 'Call',
        summary: 'Older timeline event summary',
        linked_entity_id: null,
        linked_entity_type: null,
      },
    ];

    useDataSourcesMock.mockReturnValue(staleTimelineData);
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);

    expect(screen.getByText('Latest profile interaction summary')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('shows persisted profile interaction context as timeline fallback when timeline is empty after reload', () => {
    useDataSourcesMock.mockReturnValue(
      detailMockData({
        ...profileRecord,
        last_interaction_type: 'call',
        last_interaction_summary: 'Followed up with AP contact on overdue invoice.',
      })
    );
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);

    expect(screen.getByText('Followed up with AP contact on overdue invoice.')).toBeInTheDocument();
    expect(screen.getByText('Call')).toBeInTheDocument();
  });

  it('shows a validation error when Log Interaction is submitted without a summary', async () => {
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Log Interaction' }));

    // Click submit without entering summary
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Log Interaction' }).find(
        (btn) => btn.closest('[role="dialog"]') !== null
      )!
    );

    await waitFor(() => {
      expect(screen.getByText('A summary is required.')).toBeInTheDocument();
    });

    // RPC should not be called
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('renders the Balance commercial-context card with a dollar value', () => {
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    // "Balance" label and the dollar amount heading must both be present
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('$15000')).toBeInTheDocument();
  });

  it('renders "$0" for balance when the profile has no balance data', () => {
    useDataSourcesMock.mockReturnValue(
      detailMockData({ ...profileRecord, balance: null })
    );
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByText('$0')).toBeInTheDocument();
  });

  it('renders the Avg Days to Pay card with a numeric value', () => {
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByText('Avg Days to Pay')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('renders "N/A" for avg_days_to_pay when the profile value is null', () => {
    useDataSourcesMock.mockReturnValue(
      detailMockData({ ...profileRecord, avg_days_to_pay: null })
    );
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('renders the Payment Method card with the preferred payment method', () => {
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByText('Payment Method')).toBeInTheDocument();
    expect(screen.getByText('ach')).toBeInTheDocument();
  });

  it('renders "Not set" for payment method when the profile value is null', () => {
    useDataSourcesMock.mockReturnValue(
      detailMockData({ ...profileRecord, preferred_payment_method: null })
    );
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });

  it('renders Contacts section heading', () => {
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByRole('heading', { name: 'Contacts' })).toBeInTheDocument();
  });

  it('renders Billing Accounts section heading', () => {
    useDataSourcesMock.mockReturnValue(detailMockData());
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByRole('heading', { name: 'Billing Accounts' })).toBeInTheDocument();
  });

  it('renders payment issue type as operator-readable text in issue context', () => {
    useDataSourcesMock.mockReturnValue({
      ...detailMockData({ ...profileRecord, payment_issue_flag: 0 }),
      data: {
        ...detailMockData({ ...profileRecord, payment_issue_flag: 0 }).data,
        issues: [
          {
            issue_entity_id: 'issue-1',
            issue_type: 'payment_issue',
            status: 'open',
            severity: 'high',
            owner: 'collections',
            opened_at: '2026-02-01T00:00:00Z',
          },
        ],
      },
    });
    renderWithQueryClient(<CustomerProfileDetailScreen id="cust-1" />);
    expect(screen.getByText('Payment Issue')).toBeInTheDocument();
  });

});
