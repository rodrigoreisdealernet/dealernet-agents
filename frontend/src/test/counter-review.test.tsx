import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useDataSourcesMock } = vi.hoisted(() => ({
  useDataSourcesMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

vi.mock('@/engine', async () => {
  const actual = await vi.importActual<typeof import('@/engine')>('@/engine');
  return {
    ...actual,
    useDataSources: useDataSourcesMock,
  };
});

import { CounterReviewScreen } from '@/routes/rental/counter-review';

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
    </QueryClientProvider>,
  );
}

describe('counter review screen', () => {
  beforeEach(() => {
    useDataSourcesMock.mockReset();
  });

  it('renders a unified counter review flow with evidence-backed sections', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contracts: [
          {
            id: 'contract-1',
            created_at: '2026-06-12T10:00:00Z',
            entity_versions: [{
              data: {
                contract_number: 'RC-1001',
                status: 'closed',
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
              },
            }],
          },
        ],
        invoices: [
          {
            id: 'invoice-1',
            created_at: '2026-06-13T09:00:00Z',
            entity_versions: [{
              data: {
                invoice_number: 'INV-1001',
                status: 'draft',
                contract_id: 'contract-1',
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                billing_period_start: '2026-06-01',
                billing_period_end: '2026-06-20',
                subtotal: 1200,
                tax: 120,
                total: 1300,
                billing_exception_reason: 'Missing fuel surcharge backup',
              },
            }],
          },
        ],
        customerProfiles: [
          {
            entity_id: 'customer-1',
            name: 'Acme Construction',
            tier: 'strategic',
            balance: 62000,
            credit_limit: 50000,
            avg_days_to_pay: 71,
            payment_issue_flag: 1,
            data: { last_interaction_summary: 'Customer mentioned a new project phase at the airport expansion.' },
          },
        ],
        customerIssues: [
          {
            issue_entity_id: 'issue-1',
            customer_id: 'customer-1',
            billing_account_id: 'billing-1',
            issue_type: 'ap_hold',
            status: 'open',
            severity: 'high',
            opened_at: '2026-06-12T11:00:00Z',
            data: {},
          },
        ],
        communicationTimeline: [
          {
            timeline_event_id: 'timeline-1',
            customer_id: 'customer-1',
            occurred_at: '2026-06-11T10:30:00Z',
            interaction_label: 'Customer call',
            summary: 'Discussed a multi-site project rollout with expected long-term demand.',
            linked_entity_id: 'contract-1',
            linked_entity_type: 'rental_contract',
          },
        ],
        contractLines: [
          {
            entity_id: 'line-1',
            contract_id: 'contract-1',
            asset_id: 'asset-77',
            status: 'returned',
            actual_end: '2026-06-15',
            data: {
              condition_outcome: 'fail',
              return_notes: 'Hydraulic leak found at check-in.',
              resulting_asset_status: 'on_inspection_hold',
            },
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<CounterReviewScreen />);

    expect(screen.getByRole('heading', { name: 'Counter account, return, billing, and opportunity review' })).toBeInTheDocument();
    expect(screen.getByText('AP-hold or payment blocker detected')).toBeInTheDocument();
    expect(screen.getByText('Route to service follow-up')).toBeInTheDocument();
    expect(screen.getByText('Existing billing anomaly requires review')).toBeInTheDocument();
    expect(screen.getByText('Invoice total mismatch surfaced')).toBeInTheDocument();
    expect(screen.getByText('Outside-sales handoff suggested')).toBeInTheDocument();
    expect(screen.getAllByText('Missing fuel surcharge backup').length).toBeGreaterThan(0);
    expect(screen.getByText('Hydraulic leak found at check-in.')).toBeInTheDocument();
    expect(screen.getByText('Discussed a multi-site project rollout with expected long-term demand.')).toBeInTheDocument();
    expect(screen.getAllByText('Draft review only').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Open customer profile' })[0]).toHaveAttribute('href', '/crm/customers/customer-1');
    expect(screen.getAllByText('rental-counter-coordinator:t3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('rental-counter-coordinator:t4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('rental-counter-coordinator:t6').length).toBeGreaterThan(0);
    expect(screen.getAllByText('rental-counter-coordinator:t7').length).toBeGreaterThan(0);
  });

  it('surfaces missing billing inputs instead of a clean disposition', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contracts: [
          {
            id: 'contract-2',
            created_at: '2026-06-12T10:00:00Z',
            entity_versions: [{
              data: {
                contract_number: 'RC-1002',
                status: 'pending_execution',
                customer_id: 'customer-2',
              },
            }],
          },
        ],
        invoices: [
          {
            id: 'invoice-2',
            created_at: '2026-06-13T09:00:00Z',
            entity_versions: [{
              data: {
                invoice_number: 'INV-1002',
                status: 'draft',
                contract_id: 'contract-2',
              },
            }],
          },
        ],
        customerProfiles: [
          {
            entity_id: 'customer-2',
            name: 'Metro Builders',
            balance: null,
            credit_limit: null,
            payment_issue_flag: 0,
            data: {},
          },
        ],
        customerIssues: [],
        communicationTimeline: [],
        contractLines: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<CounterReviewScreen />);

    expect(screen.getByText('Missing billing account input')).toBeInTheDocument();
    expect(screen.getByText('Missing credit-limit inputs')).toBeInTheDocument();
    expect(screen.getByText('Draft invoice inputs are incomplete')).toBeInTheDocument();
  });
});
