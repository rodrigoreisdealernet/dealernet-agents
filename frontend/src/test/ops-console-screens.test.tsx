import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useDataSourcesMock, navigateSpy, authState } = vi.hoisted(() => ({
  useDataSourcesMock: vi.fn(),
  navigateSpy: vi.fn(),
  authState: {
    value: {
      profile: { id: 'user-1', displayName: 'Casey', role: 'admin' } as { id: string; displayName: string; role: string } | null,
      session: { access_token: 'token' } as { access_token: string } | null,
    },
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    Link: ({
      children,
      to,
      search,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; search?: Record<string, unknown> }) => {
      const hrefBase = to as string;
      const searchString = search
        ? new URLSearchParams(
            Object.entries(search).reduce<Record<string, string>>((acc, [key, value]) => {
              acc[key] = String(value);
              return acc;
            }, {})
          ).toString()
        : '';
      const href = searchString ? `${hrefBase}?${searchString}` : hrefBase;
      return <a href={href} {...props}>{children}</a>;
    },
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
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
import { OpsFactoryDashboardScreen } from '@/routes/ops/index';
import { OpsFindingsQueueScreen } from '@/routes/ops/findings/index';
import { RevenueRecognitionScreen } from '@/routes/ops/revenue-recognition';
import { FleetAuditsScreen } from '@/routes/ops/fleet-audits';
import { CollectionsQueueScreen } from '@/routes/ops/collections';
import { OpsFindingDetailScreen } from '@/routes/ops/findings/$findingId';
import { OpsAuditTrailScreen } from '@/routes/ops/audit/$entityId';

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

describe('ops console screens', () => {
  beforeEach(() => {
    cleanup();
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Casey', role: 'admin' },
      session: { access_token: 'token' },
    };
  });

  it('renders dashboard KPI currency, pending badge, and recent activity', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        agent_status: [
          {
            tenant_id: 'tenant-1',
            agent_key: 'revrec-analyst',
            enabled: true,
            pending_findings: 3,
            last_run_status: 'succeeded',
            last_run_started_at: '2026-06-07T00:00:00Z',
            next_run_at: '2026-06-08T00:00:00Z',
            total_runs: 12,
            succeeded_runs: 10,
          },
        ],
        kpis: [
          {
            pending_count: 3,
            recoverable_delta: 4420,
            approved_this_cycle: 1,
            findings_last_24h: 5,
          },
        ],
        recent_activity: [
          {
            row_id: 'row-uuid-1',
            entity_id: 'entity-1',
            source_id: 'source-uuid-1',
            point_order: 1,
            fact_label: 'Agent proposed',
            entity_name: 'C-DEMO-101',
            metadata: {
              finding_id: 'finding-1',
              customer_name: 'Acme Construction',
            },
            observed_at: '2026-06-07T01:00:00Z',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFactoryDashboardScreen />);

    expect(screen.getByRole('heading', { name: 'Operations Dashboard' })).toBeInTheDocument();
    expect(screen.queryByText('Unable to load operations dashboard')).not.toBeInTheDocument();
    expect(screen.getByText('$4,420')).toBeInTheDocument();
    expect(screen.getByText('3 pending')).toBeInTheDocument();
    expect(screen.getByText('Workflow proposed')).toBeInTheDocument();
    expect(screen.getByText('Revenue Recognition')).toBeInTheDocument();

    // Dashboard KPI links to audit history
    const findingsLink = screen.getByRole('link', { name: 'Open audit history' });
    expect(findingsLink).toBeInTheDocument();
    expect(findingsLink).toHaveAttribute('href', '/ops/findings');

    const workflowLink = screen.getByRole('link', { name: 'Review revenue opportunities' });
    expect(workflowLink).toHaveAttribute('href', '/ops/revenue-recognition?status=pending_approval');
    expect(screen.getByText(/Queue context: 3 pending for tenant tenant-1/)).toBeInTheDocument();
    expect(screen.getByText(/Finding finding-1 · Contract C-DEMO-101 · Customer Acme Construction/)).toBeInTheDocument();

    // Recent activity row links to /ops/audit/:entityId with ?event= for context durability
    const auditLink = screen.getByRole('link', { name: 'View audit trail' });
    expect(auditLink).toBeInTheDocument();
    expect(auditLink.getAttribute('href')).toContain('/ops/audit/entity-1');
    expect(
      auditLink.getAttribute('href'),
      'audit trail link must carry ?event= so the selected event survives reload'
    ).toMatch(/[?&]event=row-uuid-1/);
  });

  it('scopes partial failures to the business workflows section while keeping loaded KPIs visible', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        agent_status: null,
        kpis: [
          {
            pending_count: 1,
            recoverable_delta: 5020,
            approved_this_cycle: 3,
            findings_last_24h: 0,
          },
        ],
        recent_activity: [],
      },
      isLoading: {},
      errors: {
        agent_status: new Error('Workflow service unavailable'),
      },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFactoryDashboardScreen />);

    expect(screen.queryByText('Unable to load operations dashboard')).not.toBeInTheDocument();
    expect(screen.getByText('$5,020')).toBeInTheDocument();
    expect(screen.getByText('Could not load business workflows')).toBeInTheDocument();
    expect(screen.getByText('Workflow service unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No business workflows are configured for this tenant yet.')).not.toBeInTheDocument();
  });

  it('shows the full-page dashboard alert in place of KPI cards when KPI data fails to load', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        agent_status: null,
        kpis: null,
        recent_activity: null,
      },
      isLoading: {},
      errors: {
        agent_status: new Error('Workflow service unavailable'),
        kpis: new Error('KPI query failed'),
        recent_activity: new Error('Recent activity query failed'),
      },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFactoryDashboardScreen />);

    expect(screen.getByText('Unable to load operations dashboard')).toBeInTheDocument();
    expect(screen.getByText('Retry shortly.')).toBeInTheDocument();
    expect(screen.queryByText('Items awaiting review')).not.toBeInTheDocument();
    expect(screen.queryByText('Revenue opportunities')).not.toBeInTheDocument();
    expect(screen.getByText('Could not load business workflows')).toBeInTheDocument();
    expect(screen.getByText('Could not load recent audit activity')).toBeInTheDocument();
  });

  it('recent-activity row renders entity·date text as the sibling immediately preceding the audit trail link', () => {
    // This is a regression guard for the row-child ordering in ops-factory-dashboard.json.
    // The e2e handoff test captures the entity label via xpath=preceding-sibling::*[1] on the
    // "View audit trail" link anchor, so the entity·date text MUST be the last sibling before
    // the link. If the row order is reverted (entity·date back to position 2, finding-context
    // to position 3), this test fails because previousSibling resolves to the finding-context
    // text instead of the entity name.
    useDataSourcesMock.mockReturnValue({
      data: {
        agent_status: [],
        kpis: [],
        recent_activity: [
          {
            row_id: 'row-uuid-1',
            entity_id: 'entity-1',
            source_id: 'source-uuid-1',
            point_order: 1,
            fact_label: 'Agent proposed',
            entity_name: 'C-DEMO-101',
            metadata: { finding_id: 'finding-1', customer_name: 'Acme Construction' },
            observed_at: '2026-06-07T01:00:00Z',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFactoryDashboardScreen />);

    const auditLink = screen.getByRole('link', { name: 'View audit trail' });
    // The anchor element is a child of the Link wrapper; walk up to its parent container
    // (the rendered <a>) and then to the parent Stack element that holds all row siblings.
    const linkEl = auditLink;
    const rowContainer = linkEl.parentElement;
    expect(rowContainer, 'expected audit link to have a parent container').not.toBeNull();

    // The element immediately before the link in the DOM must contain the entity name and
    // a mid-dot separator (entity_name · date format), NOT the finding-context text.
    const precedingSibling = linkEl.previousElementSibling;
    expect(precedingSibling, 'expected a sibling element immediately before the audit trail link').not.toBeNull();
    expect(
      precedingSibling!.textContent,
      'the sibling immediately preceding the "View audit trail" link must show the entity·date text (e.g. "C-DEMO-101 · …"), not finding-context text'
    ).toMatch(/C-DEMO-101/);
    expect(
      precedingSibling!.textContent,
      'the immediately-preceding sibling must contain the mid-dot separator used in entity·date lines'
    ).toMatch(/·/);
    expect(
      precedingSibling!.textContent,
      'the immediately-preceding sibling must NOT be the finding-context line'
    ).not.toMatch(/^Finding/);
  });

  it('renders findings queue list and currency values', () => {
    useDataSourcesMock.mockReturnValueOnce({
      data: {
        findings: [
          {
            id: 'finding-1',
            finding_type: 'unbilled_on_rent',
            severity: 'high',
            agent_key: 'revrec-analyst',
            status: 'pending_approval',
            contract_label: 'C-DEMO-101',
            line_item_label: 'Line 1',
            customer_name: 'Acme Construction',
            delta: 1200,
            confidence: 0.94,
            created_at: '2026-06-07T02:00:00Z',
          },
        ],
        agents: [{ agent_key: 'revrec-analyst' }],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingsQueueScreen />);
    expect(screen.getByRole('heading', { name: 'Audit History' })).toBeInTheDocument();
    expect(screen.getByLabelText('Workflow')).toBeInTheDocument();
    expect(screen.getByText('unbilled_on_rent')).toBeInTheDocument();
    expect(screen.getByText('Delta: $1,200 · Confidence: 0.94')).toBeInTheDocument();
    expect(screen.getByText('high · Revenue Recognition')).toBeInTheDocument();
  });

  it('renders dedicated revenue and fleet workflow screens', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        findings: [
          {
            id: 'finding-1',
            finding_type: 'asset_mismatch',
            severity: 'medium',
            agent_key: 'fleet-auditor',
            status: 'pending_approval',
            contract_label: 'C-DEMO-101',
            line_item_label: 'Line 1',
            customer_name: 'Acme Construction',
            delta: 250,
            confidence: 0.88,
            created_at: '2026-06-07T02:00:00Z',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const revenue = renderWithQueryClient(<RevenueRecognitionScreen />);
    expect(screen.getByRole('heading', { name: 'Revenue Recognition' })).toBeInTheDocument();
    revenue.unmount();

    renderWithQueryClient(<FleetAuditsScreen />);
    expect(screen.getByRole('heading', { name: 'Fleet Audits' })).toBeInTheDocument();
    expect(screen.getByText('medium · Fleet Audits')).toBeInTheDocument();
  });

  it('includes queue filter and context params in revenue open-finding links', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        findings: [
          {
            id: 'finding-1',
            finding_type: 'unbilled_on_rent',
            severity: 'high',
            agent_key: 'revrec-analyst',
            status: 'pending_approval',
            contract_label: 'C-DEMO-101',
            line_item_label: 'Line 1',
            customer_name: 'Acme Construction',
            delta: 1200,
            confidence: 0.94,
            created_at: '2026-06-07T02:00:00Z',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RevenueRecognitionScreen severity="high" status="%" branch="C-DEMO%" customer="Acme%" />);

    expect(screen.getByRole('link', { name: 'Open finding →' })).toHaveAttribute(
      'href',
      '/ops/findings/finding-1?source=revenue-recognition&severity=high&status=%25&branch=C-DEMO%25&customer=Acme%25&contract=C-DEMO-101&customerName=Acme+Construction&delta=1200&returnSeverity=high&returnStatus=%25&returnBranch=C-DEMO%25&returnCustomer=Acme%25'
    );
  });

  it('includes fleet queue context in open-finding links and renders readable labels', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        findings: [
          {
            id: 'finding-fleet-1',
            finding_type: 'unbilled_on_rent',
            severity: 'high',
            agent_key: 'fleet-auditor',
            status: 'pending_approval',
            contract_label: 'C-DEMO-101',
            line_item_label: 'Line 1',
            customer_name: 'Acme Construction',
            delta: 1200,
            confidence: 0.94,
            created_at: '2026-06-07T02:00:00Z',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<FleetAuditsScreen severity="high" status="pending_approval" branch="C-DEMO%" customer="Acme%" />);

    expect(screen.getByText('Unbilled while on rent')).toBeInTheDocument();
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    const openFindingHref = screen.getByRole('link', { name: 'Open finding' }).getAttribute('href');
    expect(openFindingHref).toBeTruthy();

    const openFindingUrl = new URL(openFindingHref!, 'https://example.test');
    expect(openFindingUrl.pathname).toBe('/ops/findings/finding-fleet-1');
    expect(Object.fromEntries(openFindingUrl.searchParams.entries())).toEqual({
      source: 'fleet-audits',
      severity: 'high',
      status: 'pending_approval',
      branch: 'C-DEMO%',
      customer: 'Acme%',
      contract: 'C-DEMO-101',
      customerName: 'Acme Construction',
      delta: '1200',
      returnSeverity: 'high',
      returnStatus: 'pending_approval',
      returnBranch: 'C-DEMO%',
      returnCustomer: 'Acme%',
    });
  });

  it('renders the dedicated collections workflow screen', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        findings: [
          {
            id: 'finding-collections-1',
            finding_type: 'collections_priority',
            severity: 'high',
            agent_key: 'credit-analyst',
            status: 'pending_approval',
            expected: {
              account_label: 'BA-TX-0001',
              customer_name: 'Acme Construction',
              branch_context: 'Houston North · Note: Payment delays noted on last two invoices.',
              amount: 14250,
              escalation_stage: 'approaching_formal_escalation',
              stale_inputs: ['payment_history_stale'],
            },
            billed: { amount: 18000 },
            delta: 14250,
            confidence: 0.9,
            proposed_action: 'review_notice_of_intent',
            rationale: 'AR is aging toward formal escalation.',
            created_at: '2026-06-07T02:00:00Z',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<CollectionsQueueScreen />);
    expect(screen.getByRole('heading', { name: 'AR Collections Queue' })).toBeInTheDocument();
    expect(screen.getByText('BA-TX-0001')).toBeInTheDocument();
    expect(screen.getByText('Customer: Acme Construction')).toBeInTheDocument();
    expect(screen.getByText(/Next step: review_notice_of_intent/)).toBeInTheDocument();
    expect(screen.getByText(/Uncertainty: payment_history_stale/)).toBeInTheDocument();
  });

  it('renders findings queue empty/loading/error states', () => {
    useDataSourcesMock.mockReturnValue({
      data: { findings: [], agents: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const empty = renderWithQueryClient(<OpsFindingsQueueScreen />);
    expect(screen.getByText('No findings match the selected filters.')).toBeInTheDocument();
    empty.unmount();

    useDataSourcesMock.mockReturnValue({
      data: { findings: null, agents: [] },
      isLoading: { findings: true },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const loading = renderWithQueryClient(<OpsFindingsQueueScreen />);
    expect(screen.getByText('Loading findings...')).toBeInTheDocument();
    loading.unmount();

    useDataSourcesMock.mockReturnValue({
      data: { findings: null, agents: [] },
      isLoading: {},
      errors: { findings: new Error('boom') },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingsQueueScreen />);
    expect(screen.getByText('Unable to load findings')).toBeInTheDocument();
  });

  it('shows approve/reject controls for collections findings with operator role', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-1',
          finding_type: 'collections_priority',
          severity: 'high',
          status: 'pending_approval',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          agent_key: 'credit-analyst',
          proposed_action: 'review_notice_of_intent',
          delta: 14250,
          expected_amount: 14250,
          billed_amount: 18000,
          expected: { account_label: 'BA-TX-0001', customer_name: 'Acme Construction', branch_context: 'Houston North' },
          billed: { latest_payment_at: '2026-06-01T00:00:00Z' },
          evidence: [{ summary: '3 invoices overdue > 60 days', entity_id: 'contract-1' }],
          rationale: 'AR is aging toward formal escalation.',
          confidence: 0.94,
          contract_label: null,
          line_item_label: 'Line 1',
          customer_name: null,
          contract_id: 'contract-1',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-1" />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.getByText('review_notice_of_intent')).toBeInTheDocument();
    expect(screen.getByText('Account: BA-TX-0001')).toBeInTheDocument();
    expect(screen.getByText('Branch context: Houston North')).toBeInTheDocument();
  });

  it('falls back to queue context on finding detail and links back to filtered revenue queue', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-1',
          finding_type: 'unbilled_on_rent',
          severity: 'high',
          status: 'approved',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          agent_key: 'revrec-analyst',
          proposed_action: 'create_invoice_adjustment',
          delta: null,
          expected_amount: 2400,
          billed_amount: 1200,
          expected: {},
          billed: {},
          evidence: [],
          rationale: 'Detected billable gap.',
          confidence: 0.94,
          contract_label: null,
          line_item_label: 'Line 1',
          customer_name: null,
          contract_id: 'contract-1',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(
      <OpsFindingDetailScreen
        findingId="finding-1"
        queueContext={{
          source: 'revenue-recognition',
          severity: 'high',
          status: '%',
          branch: 'C-DEMO%',
          customer: 'Acme%',
          contract: 'C-DEMO-101',
          customerName: 'Acme Construction',
          delta: 1200,
        }}
      />
    );

    expect(screen.getByText('Contract: C-DEMO-101')).toBeInTheDocument();
    expect(screen.getByText('Customer: Acme Construction')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Impact: $1,200' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to filtered revenue queue' })).toHaveAttribute(
      'href',
      '/ops/revenue-recognition?severity=high&status=%25&branch=C-DEMO%25&customer=Acme%25'
    );
  });

  it('shows zero impact from finding delta instead of stale nonzero queue fallback', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-1',
          finding_type: 'unbilled_on_rent',
          severity: 'high',
          status: 'approved',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          agent_key: 'revrec-analyst',
          proposed_action: 'create_invoice_adjustment',
          delta: 0,
          expected_amount: 2400,
          billed_amount: 2400,
          expected: {},
          billed: {},
          evidence: [],
          rationale: 'Detected resolved gap.',
          confidence: 0.94,
          contract_label: null,
          line_item_label: 'Line 1',
          customer_name: null,
          contract_id: 'contract-1',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(
      <OpsFindingDetailScreen
        findingId="finding-1"
        queueContext={{
          source: 'revenue-recognition',
          severity: 'high',
          status: '%',
          branch: 'C-DEMO%',
          customer: 'Acme%',
          contract: 'C-DEMO-101',
          customerName: 'Acme Construction',
          delta: 1200,
        }}
      />
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Impact: $0' })).toBeInTheDocument();
  });

  it('hides approve/reject controls for read-only users', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Casey', role: 'read_only' },
      session: { access_token: 'token' },
    };

    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-1',
          finding_type: 'unbilled_on_rent',
          severity: 'high',
          status: 'pending_approval',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          proposed_action: 'create_invoice_adjustment',
          delta: 1200,
          expected_amount: 2400,
          billed_amount: 1200,
          expected: { rate_type: 'weekly' },
          billed: { rate_type: 'weekly' },
          evidence: [{ summary: 'Missing invoice line', entity_id: 'contract-1' }],
          rationale: 'Detected billable gap.',
          confidence: 0.94,
          agent_key: 'revrec-analyst',
          contract_label: 'C-DEMO-101',
          line_item_label: 'Line 1',
          customer_name: 'Acme Construction',
          contract_id: 'contract-1',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-1" />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Read-only')).toHaveLength(2);
    expect(screen.getByText('You can review this finding, but only operators can approve or reject.')).toBeInTheDocument();
  });

  it('refreshes auth-derived finding state after auth hydration on reload', () => {
    authState.value = {
      profile: null as { id: string; displayName: string; role: string } | null,
      session: null as { access_token: string } | null,
    };

    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-1',
          finding_type: 'unbilled_on_rent',
          severity: 'high',
          status: 'pending_approval',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          proposed_action: 'create_invoice_adjustment',
          delta: 1200,
          expected_amount: 2400,
          billed_amount: 1200,
          expected: { rate_type: 'weekly' },
          billed: { rate_type: 'weekly' },
          evidence: [{ summary: 'Missing invoice line', entity_id: 'contract-1' }],
          rationale: 'Detected billable gap.',
          confidence: 0.94,
          agent_key: 'revrec-analyst',
          contract_label: 'C-DEMO-101',
          line_item_label: 'Line 1',
          customer_name: 'Acme Construction',
          contract_id: 'contract-1',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <OpsFindingDetailScreen findingId="finding-1" />
      </QueryClientProvider>
    );
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Casey', role: 'read_only' },
      session: { access_token: 'token-ro' },
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <OpsFindingDetailScreen findingId="finding-1" />
      </QueryClientProvider>
    );

    const latestContext = useDataSourcesMock.mock.calls[useDataSourcesMock.mock.calls.length - 1]?.[1];
    expect(latestContext.state).toMatchObject({
      accessToken: 'token-ro',
      approverId: 'user-ro',
      approverName: 'Casey',
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Read-only')).toHaveLength(2);
    expect(screen.getByText('You can review this finding, but only operators can approve or reject.')).toBeInTheDocument();
  });

  it('hides triage controls and shows read-only alert for informational findings', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Casey', role: 'read_only' },
      session: { access_token: 'token' },
    };

    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-2',
          finding_type: 'billing_note',
          severity: 'low',
          status: 'informational',
          workflow_id: 'wf-456',
          run_id: 'run-456',
          proposed_action: null,
          delta: 0,
          expected_amount: 0,
          billed_amount: 0,
          expected: {},
          billed: {},
          evidence: [],
          rationale: 'Informational only.',
          confidence: 1,
          agent_key: 'revrec-analyst',
          contract_label: 'C-DEMO-102',
          line_item_label: 'Line 2',
          customer_name: 'Globex Corp',
          contract_id: 'contract-2',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-2" />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Read-only')).toHaveLength(2);
    expect(screen.getByText('You can review this finding, but only operators can approve or reject.')).toBeInTheDocument();
  });

  it('shows read-only alert while finding data is still loading', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Casey', role: 'read_only' },
      session: { access_token: 'token' },
    };

    useDataSourcesMock.mockReturnValue({
      data: { finding: null },
      isLoading: { finding: true },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-1" />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    const readOnlyDescription = screen.getByText('You can review this finding, but only operators can approve or reject.');
    const loadingMessage = screen.getByText('Loading finding detail...');

    expect(readOnlyDescription).toBeInTheDocument();
    expect(readOnlyDescription).not.toHaveClass('text-muted-foreground');
    expect(loadingMessage).toBeInTheDocument();
    expect(loadingMessage).toHaveClass('text-foreground');
    expect(loadingMessage).not.toHaveClass('text-muted-foreground');
  });

  it('shows read-only alert when finding data is null and not loading', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Casey', role: 'read_only' },
      session: { access_token: 'token' },
    };

    useDataSourcesMock.mockReturnValue({
      data: { finding: null },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-1" />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByText('You can review this finding, but only operators can approve or reject.')).toBeInTheDocument();
  });

  it('shows read-only alert when finding fetch errors after reload', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Casey', role: 'read_only' },
      session: { access_token: 'token' },
    };

    useDataSourcesMock.mockReturnValue({
      data: { finding: null },
      isLoading: {},
      errors: { finding: new Error('connection lost') },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-1" />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByText('You can review this finding, but only operators can approve or reject.')).toBeInTheDocument();
    expect(screen.getByText('Unable to load finding')).toBeInTheDocument();
  });

  it('submits approve decision through the decision API contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'accepted', idempotent: false }), { status: 202 })
    );
    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-1',
          finding_type: 'unbilled_on_rent',
          severity: 'high',
          status: 'pending_approval',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          proposed_action: 'create_invoice_adjustment',
          delta: 1200,
          expected_amount: 2400,
          billed_amount: 1200,
          expected: { rate_type: 'weekly' },
          billed: { rate_type: 'weekly' },
          evidence: [{ summary: 'Missing invoice line', entity_id: 'contract-1' }],
          rationale: 'Detected billable gap.',
          confidence: 0.94,
          agent_key: 'revrec-analyst',
          contract_label: 'C-DEMO-101',
          line_item_label: 'Line 1',
          customer_name: 'Acme Construction',
          contract_id: 'contract-1',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-1" />);
    fireEvent.change(screen.getByLabelText('Approval note (optional)'), {
      target: { value: 'Looks good' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/ops/findings/decision',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          finding_id: 'finding-1',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          decision: 'approve',
          approver_id: 'user-1',
          note: 'Looks good',
        }),
      })
    );

    fetchMock.mockRestore();
  });

  it('submits reject decision through the decision API contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'accepted', idempotent: false }), { status: 202 })
    );
    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-1',
          finding_type: 'unbilled_on_rent',
          severity: 'high',
          status: 'pending_approval',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          proposed_action: 'create_invoice_adjustment',
          delta: 1200,
          expected_amount: 2400,
          billed_amount: 1200,
          expected: { rate_type: 'weekly' },
          billed: { rate_type: 'weekly' },
          evidence: [{ summary: 'Missing invoice line', entity_id: 'contract-1' }],
          rationale: 'Detected billable gap.',
          confidence: 0.94,
          agent_key: 'revrec-analyst',
          contract_label: 'C-DEMO-101',
          line_item_label: 'Line 1',
          customer_name: 'Acme Construction',
          contract_id: 'contract-1',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-1" />);
    fireEvent.change(screen.getByLabelText('Reject reason'), {
      target: { value: 'Insufficient confidence' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/ops/findings/decision',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          finding_id: 'finding-1',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          decision: 'reject',
          approver_id: 'user-1',
          reason: 'Insufficient confidence',
        }),
      })
    );

    fetchMock.mockRestore();
  });

  it('does not send approver_name when auth profile displayName comes from display_name', async () => {
    authState.value = {
      profile: { id: 'user-1', displayName: 'Display Name Only', role: 'admin' },
      session: { access_token: 'token' },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'accepted', idempotent: false }), { status: 202 })
    );
    useDataSourcesMock.mockReturnValue({
      data: {
        finding: {
          id: 'finding-1',
          finding_type: 'unbilled_on_rent',
          severity: 'high',
          status: 'pending_approval',
          workflow_id: 'wf-123',
          run_id: 'run-123',
          proposed_action: 'create_invoice_adjustment',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsFindingDetailScreen findingId="finding-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      finding_id: 'finding-1',
      workflow_id: 'wf-123',
      run_id: 'run-123',
      decision: 'approve',
      approver_id: 'user-1',
    });
    expect(body).not.toHaveProperty('approver_name');

    fetchMock.mockRestore();
  });

  it('renders audit trail timeline details', () => {
    useDataSourcesMock.mockReturnValueOnce({
      data: {
        finding_context: [
          {
            id: 'finding-1',
            finding_type: 'billing_past_return',
            contract_label: 'C-DEMO-101',
            customer_name: 'Acme Construction',
          },
        ],
        audit: [
          {
            row_id: 'row-uuid-1',
            entity_id: 'entity-1',
            source_id: 'source-uuid-1',
            point_order: 1,
            fact_label: 'Agent proposed',
            observed_at: '2026-06-07T01:00:00Z',
            entity_name: 'C-DEMO-101',
            metadata: { actor_name: 'revrec-analyst' },
            data_payload: { event_type: 'finding_approved', approved_by: 'ops.manager@example.com' },
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsAuditTrailScreen entityId="entity-1" />);
    expect(screen.getByRole('heading', { name: 'Audit Trail' })).toBeInTheDocument();
    expect(screen.getByText('Finding: Billing past return')).toBeInTheDocument();
    expect(screen.getByText('Contract: C-DEMO-101')).toBeInTheDocument();
    expect(screen.getByText('Customer: Acme Construction')).toBeInTheDocument();
    expect(screen.getByText('Workflow proposed')).toBeInTheDocument();
    expect(screen.getByText('Actor: Revenue Recognition')).toBeInTheDocument();
    // Summary shows human-readable event description
    expect(screen.getByText('Summary: Finding approved by ops.manager@example.com.')).toBeInTheDocument();
    // Payload shows human-readable summary, not raw JSON
    expect(screen.getByText(/^Payload: Approved by ops\.manager@example\.com/)).toBeInTheDocument();
    // No active event indicator when no activeEvent param is provided
    expect(screen.queryByText('Active event')).not.toBeInTheDocument();
  });

  it('renders readable audit label and entity/timestamp fallbacks when event metadata is sparse', () => {
    useDataSourcesMock.mockReturnValueOnce({
      data: {
        audit: [
          {
            row_id: 'row-uuid-1',
            entity_id: 'entity-1',
            source_id: 'source-uuid-1',
            point_order: 1,
            metadata: { actor_name: 'revrec-analyst' },
            data_payload: { reason: 'Manual review required' },
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsAuditTrailScreen entityId="entity-1" />);
    expect(screen.getByText('Workflow event')).toBeInTheDocument();
    expect(screen.getByText('entity-1 · Date unavailable')).toBeInTheDocument();
  });

  it('highlights active event when activeEvent param matches row_id (not source_id)', () => {
    // Two rows that share the same source_id to prove row_id is used for uniqueness.
    // source_id is not unique across all fact types (see migration
    // 20260610210000_pm_source_dedup_narrow.sql) so using it would highlight
    // the wrong row when multiple rows carry the same batch source_id.
    const auditFixture = [
      {
        row_id: 'row-uuid-1',
        entity_id: 'entity-1',
        source_id: 'shared-batch-source',
        point_order: 1,
        fact_label: 'Agent proposed',
        observed_at: '2026-06-07T01:00:00Z',
        entity_name: 'C-DEMO-101',
        metadata: { actor_name: 'revrec-analyst' },
        data_payload: { event_type: 'finding_approved', approved_by: 'ops.manager@example.com' },
      },
      {
        row_id: 'row-uuid-2',
        entity_id: 'entity-1',
        source_id: 'shared-batch-source',
        point_order: 2,
        fact_label: 'Manager reviewed',
        observed_at: '2026-06-07T02:00:00Z',
        entity_name: 'C-DEMO-101',
        metadata: { actor_name: 'ops.manager' },
        data_payload: { reason: 'All checks passed' },
      },
    ];
    const mockDataSource = { data: { audit: auditFixture }, isLoading: {}, errors: {}, isPageLoading: false, refetch: vi.fn(), refetchAll: vi.fn() };

    // No activeEvent: no indicator shown
    useDataSourcesMock.mockReturnValue(mockDataSource);
    const { unmount } = renderWithQueryClient(<OpsAuditTrailScreen entityId="entity-1" />);
    expect(screen.queryByText('Active event')).not.toBeInTheDocument();
    unmount();

    // With activeEvent = row-uuid-2: exactly one indicator visible, for the second row only.
    // If source_id were used instead, both rows would be highlighted because they share
    // the same source_id value.
    useDataSourcesMock.mockReturnValue(mockDataSource);
    renderWithQueryClient(<OpsAuditTrailScreen entityId="entity-1" activeEvent="row-uuid-2" />);
    const activeIndicators = screen.getAllByText('Active event');
    expect(activeIndicators).toHaveLength(1);
  });

  it('renders audit trail empty/loading/error states', () => {
    useDataSourcesMock.mockReturnValue({
      data: { audit: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const empty = renderWithQueryClient(<OpsAuditTrailScreen entityId="entity-1" />);
    expect(screen.getByText('No audit events found for this entity.')).toBeInTheDocument();
    empty.unmount();

    useDataSourcesMock.mockReturnValue({
      data: { audit: null },
      isLoading: { audit: true },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const loading = renderWithQueryClient(<OpsAuditTrailScreen entityId="entity-1" />);
    expect(screen.getByText('Loading audit trail...')).toBeInTheDocument();
    loading.unmount();

    useDataSourcesMock.mockReturnValue({
      data: { audit: null },
      isLoading: {},
      errors: { audit: new Error('boom') },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OpsAuditTrailScreen entityId="entity-1" />);
    expect(screen.getByText('Unable to load audit trail')).toBeInTheDocument();
  });
});
