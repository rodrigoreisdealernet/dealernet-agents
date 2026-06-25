import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useDataSourcesMock } = vi.hoisted(() => ({
  useDataSourcesMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );

  return {
    ...actual,
    Link: ({
      children,
      to,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => {
      const href = typeof to === 'string' ? to : props.href;
      return (
        <a {...props} href={href}>
          {children}
        </a>
      );
    },
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { INCIDENT_SOURCE_GAP_EXCEPTION } from '@/lib/reporting/safety-compliance-pack';
import { SafetyCompliancePackScreen } from '@/routes/analytics/safety';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function buildBaseData() {
  return {
    audit_findings: [
      {
        id: 'finding-1',
        contract_id: 'contract-1',
        contract_label: 'North Branch Audit',
        customer_name: 'Acme Construction',
        finding_type: 'missing_guardrail',
        severity: 'high',
        status: 'pending_approval',
        evidence: [],
        proposed_action: 'Collect updated training evidence.',
        created_at: '2026-05-20T12:00:00Z',
      },
      {
        id: 'finding-2',
        contract_id: 'contract-1',
        contract_label: 'North Branch Audit',
        customer_name: 'Acme Construction',
        finding_type: 'missing_guardrail',
        severity: 'medium',
        status: 'pending_approval',
        evidence: [{ id: 'ev-2' }],
        proposed_action: 'Verify guardrail checklist.',
        created_at: '2026-06-10T12:00:00Z',
      },
    ],
    corrective_action_candidates: [
      {
        relationship_id: 'rel-1',
        project_id: 'project-1',
        project_name: 'Forklift refresher rollout',
        asset_id: 'asset-1',
        asset_name: 'Forklift 1',
        assigned_at: '2026-05-20T10:00:00Z',
        blocked: true,
        blockers: [
          {
            code: 'missing_labor_certification',
            reason: 'Labor certification forklift_level_2 is required.',
          },
        ],
        blocker_count: 1,
        readiness_state: 'blocked',
        requirements: { labor_certifications: ['forklift_level_2'] },
        evaluated_at: '2026-06-18T08:00:00Z',
      },
    ],
    driver_behavior_summary: [
      {
        total_routes: 12,
        eld_violation_count: 2,
      },
    ],
    driver_behavior_exceptions: [
      {
        line_id: 'line-1',
        asset_name: 'Truck 1',
        driver_log_status: 'out_of_hours',
        eld_compliance_status: 'violation',
        updated_at: '2026-06-19T08:00:00Z',
      },
      {
        line_id: 'line-2',
        asset_name: 'Truck 2',
        driver_log_status: 'missing',
        eld_compliance_status: 'warning',
        updated_at: null,
      },
    ],
  };
}

describe('safety compliance pack screen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T12:00:00Z'));
    initializeRegistry();
    useDataSourcesMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders workspace sections, source gaps, and human-decision focus areas', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<SafetyCompliancePackScreen />);

    expect(
      screen.getByRole('heading', { name: 'Safety audit closure and KPI pack' }),
    ).toBeInTheDocument();
    expect(screen.getByText('safety-compliance-manager:t5')).toBeInTheDocument();
    expect(screen.getByText('safety-compliance-manager:t8')).toBeInTheDocument();
    expect(screen.getByText('Human approval remains required')).toBeInTheDocument();
    expect(screen.getByText('Audit findings workspace')).toBeInTheDocument();
    expect(screen.getByText('Corrective-action and training blockers')).toBeInTheDocument();
    expect(screen.getByText('Leadership KPI pack draft')).toBeInTheDocument();
    expect(screen.getAllByText('Repeat finding').length).toBeGreaterThan(0);
    expect(screen.getByText(INCIDENT_SOURCE_GAP_EXCEPTION)).toBeInTheDocument();
    expect(screen.getAllByText('Human decision required').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Open finding detail' })[0]).toHaveAttribute(
      'href',
      '/ops/findings/finding-1',
    );
    expect(screen.getByRole('link', { name: 'Open project' })).toHaveAttribute(
      'href',
      '/entities/project/project-1',
    );
  });

  it('renders loading and error states', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        audit_findings: null,
        corrective_action_candidates: null,
        driver_behavior_summary: null,
        driver_behavior_exceptions: null,
      },
      isLoading: {
        audit_findings: true,
        corrective_action_candidates: false,
      },
      errors: {
        corrective_action_candidates: new Error('readiness query failed'),
      },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<SafetyCompliancePackScreen />);

    expect(screen.getByText('Loading audit findings...')).toBeInTheDocument();
    expect(screen.getByText('Unable to load corrective actions')).toBeInTheDocument();
  });
});
