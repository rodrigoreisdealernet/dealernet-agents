/**
 * Screen tests for ComplianceReadinessQueueScreen
 * (routes/ops/compliance-readiness-queue.tsx).
 *
 * Covers: heading, loading state, error state, no-op state, exception cards
 * with evidence drill-down, blocking vs follow-up vs reminder distinctions,
 * human-approval gating, filter row rendering, and filter interaction.
 */
import { useState } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock factories before vi.mock runs
// ---------------------------------------------------------------------------

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: { from: fromMock },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => (opts: { component: unknown }) => opts,
    useNavigate: () => vi.fn(),
  };
});

// Import after mocks
import { ComplianceReadinessQueueScreen } from '@/routes/ops/compliance-readiness-queue';

// ---------------------------------------------------------------------------
// Supabase mock builder
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown[]; error: null | { message: string } }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'filter', 'order', 'limit', 'maybeSingle', 'single']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (
    resolve: (v: typeof result) => unknown,
    reject?: (r: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

// ---------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------

function makeDriverQualRow(overrides: Record<string, unknown> = {}) {
  return {
    person_id: 'driver-001',
    person_name: 'Alice Smith',
    branch_id: 'branch-north',
    branch_name: 'North Yard',
    equipment_class: 'CDL Class A',
    qualification_type: 'Annual review',
    expiry_date: null,
    status: 'expired',
    cited_rule: '49 CFR 391',
    evidence_ref: 'DQ-2024-001',
    ...overrides,
  };
}

function makeHosRow(overrides: Record<string, unknown> = {}) {
  return {
    person_id: 'driver-002',
    person_name: 'Bob Jones',
    branch_id: 'branch-south',
    branch_name: 'South Depot',
    equipment_class: 'CDL Class B',
    violation_type: '11-hour limit',
    violation_date: '2026-06-10',
    cited_rule: '49 CFR 395',
    evidence_ref: 'ELD-001',
    severity: 'critical',
    ...overrides,
  };
}

function makeTrainingRow(overrides: Record<string, unknown> = {}) {
  return {
    person_id: 'emp-001',
    person_name: 'Dave Brown',
    branch_id: 'branch-west',
    branch_name: 'West Branch',
    equipment_class: 'Crane',
    training_type: 'Annual rigging safety',
    due_date: null,
    status: 'overdue',
    cited_rule: 'Internal training policy',
    evidence_ref: 'LMS-099',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Table mock wiring
// ---------------------------------------------------------------------------

type MockOpts = {
  driverQuals?: unknown[];
  hosExceptions?: unknown[];
  operatorCerts?: unknown[];
  trainingRecords?: unknown[];
  fetchError?: { message: string };
};

function mockTables(opts: MockOpts = {}) {
  const {
    driverQuals = [],
    hosExceptions = [],
    operatorCerts = [],
    trainingRecords = [],
    fetchError,
  } = opts;

  fromMock.mockImplementation((table: string) => {
    if (table === 'v_driver_qualification_exceptions') {
      return makeChain(fetchError ? { data: [], error: fetchError } : { data: driverQuals, error: null });
    }
    if (table === 'v_hos_exceptions_current') {
      return makeChain({ data: hosExceptions, error: null });
    }
    if (table === 'v_operator_cert_exceptions') {
      return makeChain({ data: operatorCerts, error: null });
    }
    if (table === 'v_training_compliance_exceptions') {
      return makeChain({ data: trainingRecords, error: null });
    }
    return makeChain({ data: [], error: null });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComplianceReadinessQueueScreen', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  // ── Heading ────────────────────────────────────────────────────────────────

  it('renders the page heading immediately', () => {
    mockTables();
    render(<ComplianceReadinessQueueScreen />);
    expect(screen.getByTestId('compliance-queue-heading')).toBeInTheDocument();
    expect(screen.getByTestId('compliance-queue-heading')).toHaveTextContent('Driver & Operator Compliance Readiness');
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('shows the loading alert while data is being fetched', async () => {
    fromMock.mockImplementation(() => {
      const chain = makeChain({ data: [], error: null });
      chain.then = (() => new Promise(() => {})) as typeof chain.then;
      return chain;
    });

    render(<ComplianceReadinessQueueScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('compliance-loading')).toBeInTheDocument();
    });
  });

  // ── Error state ────────────────────────────────────────────────────────────

  it('shows an error alert when a fetch fails', async () => {
    mockTables({ fetchError: { message: 'Connection refused' } });

    render(<ComplianceReadinessQueueScreen />);

    const errorAlert = await screen.findByTestId('compliance-error');
    expect(errorAlert).toBeInTheDocument();
    expect(errorAlert).toHaveTextContent('Connection refused');
  });

  // ── No-op state ────────────────────────────────────────────────────────────

  it('shows the no-op state when there are no compliance exceptions', async () => {
    mockTables({ driverQuals: [], hosExceptions: [], operatorCerts: [], trainingRecords: [] });

    render(<ComplianceReadinessQueueScreen />);

    const noOp = await screen.findByTestId('compliance-no-op');
    expect(noOp).toBeInTheDocument();
    expect(noOp).toHaveTextContent('No compliance exceptions found');
  });

  // ── Exception cards rendered ───────────────────────────────────────────────

  it('renders exception cards for each exception', async () => {
    mockTables({
      driverQuals: [makeDriverQualRow()],
    });

    render(<ComplianceReadinessQueueScreen />);

    await screen.findByTestId('compliance-exception-list');
    const cards = screen.getAllByTestId('compliance-exception-card');
    expect(cards.length).toBeGreaterThan(0);
  });

  it('shows person name on each exception card', async () => {
    mockTables({ driverQuals: [makeDriverQualRow()] });

    render(<ComplianceReadinessQueueScreen />);

    await screen.findByTestId('compliance-exception-list');
    expect(screen.getByTestId('exception-person-name')).toHaveTextContent('Alice Smith');
  });

  // ── Blocking recommendation + human approval ──────────────────────────────

  it('shows Blocking badge and "Requires human approval" badge for blocking exceptions', async () => {
    mockTables({ driverQuals: [makeDriverQualRow({ status: 'expired' })] });

    render(<ComplianceReadinessQueueScreen />);

    await screen.findByTestId('compliance-exception-list');
    expect(screen.getByTestId('exception-recommendation-badge')).toHaveTextContent('Blocking');
    expect(screen.getByTestId('exception-approval-badge')).toHaveTextContent('Requires human approval');
  });

  it('does NOT show "Requires human approval" badge for non-blocking exceptions', async () => {
    mockTables({ trainingRecords: [makeTrainingRow({ status: 'overdue' })] });

    render(<ComplianceReadinessQueueScreen />);

    await screen.findByTestId('compliance-exception-list');
    expect(screen.queryByTestId('exception-approval-badge')).not.toBeInTheDocument();
  });

  // ── Summary badges ────────────────────────────────────────────────────────

  it('shows accurate blocking summary badge when blocking exceptions exist', async () => {
    mockTables({ driverQuals: [makeDriverQualRow({ status: 'expired' })] });

    render(<ComplianceReadinessQueueScreen />);

    const badge = await screen.findByTestId('summary-blocking-badge');
    expect(badge).toHaveTextContent('1 blocking');
  });

  it('shows follow-up summary badge for non-critical HOS exception', async () => {
    mockTables({ hosExceptions: [makeHosRow({ severity: 'warning' })] });

    render(<ComplianceReadinessQueueScreen />);

    const badge = await screen.findByTestId('summary-follow-up-badge');
    expect(badge).toHaveTextContent('1 follow-up');
  });

  // ── Evidence drill-down ────────────────────────────────────────────────────

  it('hides evidence list initially and shows it on toggle', async () => {
    mockTables({ driverQuals: [makeDriverQualRow()] });

    render(<ComplianceReadinessQueueScreen />);

    await screen.findByTestId('compliance-exception-list');

    expect(screen.queryByTestId('exception-detail-panel')).not.toBeInTheDocument();

    const toggleButton = screen.getByTestId('exception-drill-down-toggle');
    fireEvent.click(toggleButton);

    expect(screen.getByTestId('exception-detail-panel')).toBeInTheDocument();
    expect(screen.getByTestId('exception-evidence-list')).toBeInTheDocument();
    expect(screen.getByTestId('exception-human-action')).toBeInTheDocument();
  });

  it('shows evidence labels in drill-down', async () => {
    mockTables({ driverQuals: [makeDriverQualRow()] });

    render(<ComplianceReadinessQueueScreen />);

    await screen.findByTestId('compliance-exception-list');

    fireEvent.click(screen.getByTestId('exception-drill-down-toggle'));

    const evidenceList = screen.getByTestId('exception-evidence-list');
    expect(evidenceList).toHaveTextContent('Person');
    expect(evidenceList).toHaveTextContent('Branch');
    expect(evidenceList).toHaveTextContent('Cited rule');
  });

  // ── Filter row rendering ───────────────────────────────────────────────────

  it('renders the filter row after data loads', async () => {
    mockTables();

    render(<ComplianceReadinessQueueScreen />);

    await screen.findByTestId('compliance-no-op');
    expect(screen.getByTestId('compliance-filter-row')).toBeInTheDocument();
    expect(screen.getByTestId('filter-branch')).toBeInTheDocument();
    expect(screen.getByTestId('filter-exception-type')).toBeInTheDocument();
    expect(screen.getByTestId('filter-recommendation')).toBeInTheDocument();
    expect(screen.getByTestId('filter-person')).toBeInTheDocument();
  });

  // ── Branch filter behavior ─────────────────────────────────────────────────

  it('shows only matching-branch exceptions when branch filter is applied', async () => {
    mockTables({
      driverQuals: [
        makeDriverQualRow({ person_name: 'Alice Smith', branch_name: 'North Yard', branch_id: 'branch-north' }),
        makeDriverQualRow({ person_id: 'driver-002', person_name: 'Carol Lee', branch_name: 'South Depot', branch_id: 'branch-south' }),
      ],
    });

    render(<ComplianceReadinessQueueScreen branch="North Yard" />);

    await screen.findByTestId('compliance-exception-list');

    const cards = screen.getAllByTestId('compliance-exception-card');
    expect(cards).toHaveLength(1);
    expect(screen.getByTestId('exception-person-name')).toHaveTextContent('Alice Smith');
    expect(screen.queryByText('Carol Lee')).not.toBeInTheDocument();
  });

  it('typing in the branch filter input filters the visible exception list', async () => {
    mockTables({
      driverQuals: [
        makeDriverQualRow({ person_name: 'Alice Smith', branch_name: 'North Yard', branch_id: 'branch-north' }),
        makeDriverQualRow({ person_id: 'driver-002', person_name: 'Carol Lee', branch_name: 'South Depot', branch_id: 'branch-south' }),
      ],
    });

    // Stateful harness: propagates onStateChange back as updated props so the
    // screen re-filters on input change, proving the DOM actually updates.
    function Harness() {
      const [filters, setFilters] = useState<{ branch: string; exceptionType: string; recommendation: string; person: string }>(
        { branch: '%', exceptionType: '%', recommendation: '%', person: '%' },
      );
      return <ComplianceReadinessQueueScreen {...filters} onStateChange={setFilters} />;
    }

    render(<Harness />);

    await screen.findByTestId('compliance-exception-list');
    expect(screen.getAllByTestId('compliance-exception-card')).toHaveLength(2);

    fireEvent.change(screen.getByTestId('filter-branch'), { target: { value: 'North Yard' } });

    await waitFor(() => {
      expect(screen.getAllByTestId('compliance-exception-card')).toHaveLength(1);
    });
    expect(screen.getByTestId('exception-person-name')).toHaveTextContent('Alice Smith');
    expect(screen.queryByText('Carol Lee')).not.toBeInTheDocument();
  });

  // ── Cited rule visible on card ─────────────────────────────────────────────

  it('shows the cited rule on the exception card', async () => {
    mockTables({ hosExceptions: [makeHosRow()] });

    render(<ComplianceReadinessQueueScreen />);

    await screen.findByTestId('compliance-exception-list');
    expect(screen.getByTestId('exception-cited-rule')).toHaveTextContent('49 CFR 395');
  });
});
