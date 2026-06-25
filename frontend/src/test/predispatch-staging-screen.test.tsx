/**
 * Screen tests for PredispatchStagingScreen (routes/dispatch/predispatch.tsx).
 *
 * Covers: staged lines, blocking exceptions with evidence, empty-window/no-op
 * path, operating-model badges, loading state, and error state.
 */
import { render, screen, waitFor } from '@testing-library/react';
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
  };
});

// Import after mocks are registered
import { PredispatchStagingScreen } from '@/routes/dispatch/predispatch';

// ---------------------------------------------------------------------------
// Supabase mock builder — builds a fully-chainable query that resolves with
// `result` when awaited.  Every method returns `this` so arbitrary chains work.
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown[]; error: null | { message: string } }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'filter', 'order', 'limit', 'maybeSingle', 'single']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Make awaitable
  chain.then = (
    resolve: (v: typeof result) => unknown,
    reject?: (r: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

// ---------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------

function makeDispatchLine(overrides: Record<string, unknown> = {}) {
  return {
    entity_id: 'line-001',
    contract_id: 'contract-001',
    asset_id: 'asset-001',
    category_id: 'cat-001',
    status: 'pending_execution',
    actual_start: null,
    actual_end: null,
    data: {
      planned_start: new Date().toISOString().slice(0, 10),
      asset_name: 'Excavator 320',
      category_name: 'Excavators',
    },
    ...overrides,
  };
}

function makeContract(contractId = 'contract-001', dataOverrides: Record<string, unknown> = {}) {
  return {
    id: contractId,
    entity_versions: [{
      is_current: true,
      data: {
        contract_number: 'RC-001',
        status: 'active',
        customer_id: 'cust-001',
        customer_name: 'Acme Construction',
        contact_name: 'Jane Doe',
        delivery_address: '123 Main St, Springfield',
        job_site_id: 'site-001',
        job_site_name: 'Site Alpha',
        delivery_instructions: 'Call before arrival.',
        branch_id: 'branch-001',
        ...dataOverrides,
      },
    }],
  };
}

function makeYardRow(assetId = 'asset-001') {
  return {
    activity_id: 'activity-001',
    lane_key: 'going_out',
    contract_id: 'contract-001',
    contract_line_id: 'line-001',
    asset_id: assetId,
    asset_name: 'Excavator 320',
    asset_category_name: 'Excavators',
    job_site_id: 'site-001',
    job_site_name: 'Site Alpha',
    customer_name: 'Acme Construction',
    branch_id: 'branch-001',
    scheduled_start_at: null,
    sort_at: null,
  };
}

// ---------------------------------------------------------------------------
// Setup helper — wire fromMock so each table returns fixed rows
// ---------------------------------------------------------------------------

function mockTables(opts: {
  dispatchLines?: ReturnType<typeof makeDispatchLine>[];
  contracts?: ReturnType<typeof makeContract>[];
  yardRows?: ReturnType<typeof makeYardRow>[];
  dispatchError?: { message: string };
} = {}) {
  const {
    dispatchLines = [makeDispatchLine()],
    contracts = [makeContract()],
    yardRows = [makeYardRow()],
    dispatchError,
  } = opts;

  fromMock.mockImplementation((table: string) => {
    if (table === 'v_rental_contract_line_current') {
      return makeChain(dispatchError
        ? { data: [], error: dispatchError }
        : { data: dispatchLines, error: null });
    }
    if (table === 'entities') {
      return makeChain({ data: contracts, error: null });
    }
    if (table === 'v_live_yard_activity_current') {
      return makeChain({ data: yardRows, error: null });
    }
    return makeChain({ data: [], error: null });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PredispatchStagingScreen', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  // ── Page heading ───────────────────────────────────────────────────────────

  it('renders the page heading immediately', () => {
    mockTables();
    render(<PredispatchStagingScreen />);
    expect(screen.getByTestId('predispatch-heading')).toBeInTheDocument();
    expect(screen.getByTestId('predispatch-heading')).toHaveTextContent('Predispatch Staging Assistant');
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('shows the loading alert while data is being fetched', async () => {
    // Hold the promise open so the component stays in loading state
    let resolveFetch: (v: unknown) => void = () => {};
    fromMock.mockImplementation(() => {
      const chain = makeChain({ data: [], error: null });
      // Override `then` to use a manual promise
      chain.then = (resolve: (v: unknown) => unknown) => {
        resolveFetch = resolve as (v: unknown) => void;
        return new Promise(() => {}); // never resolves until we trigger it
      };
      return chain;
    });

    render(<PredispatchStagingScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('predispatch-loading')).toBeInTheDocument();
    });

    // Resolve the dangling promise to let React finish cleanly after the assertion
    resolveFetch({ data: [], error: null });
  });

  // ── Error state ────────────────────────────────────────────────────────────

  it('shows an error alert when the dispatch lines fetch fails', async () => {
    mockTables({ dispatchError: { message: 'DB connection refused' } });

    render(<PredispatchStagingScreen />);

    const errorAlert = await screen.findByTestId('predispatch-error');
    expect(errorAlert).toBeInTheDocument();
    expect(errorAlert).toHaveTextContent('DB connection refused');
  });

  // ── Empty-window / no-op path ─────────────────────────────────────────────

  it('renders the no-op message when no pending dispatch lines exist', async () => {
    mockTables({ dispatchLines: [], contracts: [], yardRows: [] });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');
    expect(screen.getByText(/No pending dispatch lines in the current window/i)).toBeInTheDocument();
    expect(screen.queryByTestId('staging-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('staging-exception')).not.toBeInTheDocument();
  });

  // ── Staged lines ───────────────────────────────────────────────────────────

  it('renders a staging item for a fully-ready line', async () => {
    mockTables();

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const items = screen.getAllByTestId('staging-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('RC-001');
    expect(items[0]).toHaveTextContent('Ready to stage');
  });

  it('marks a staging item as Blocked when a blocking exception is present', async () => {
    mockTables({
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const items = screen.getAllByTestId('staging-item');
    expect(items[0]).toHaveTextContent('Blocked');
  });

  it('renders a contract link on staging items when a contractId is present', async () => {
    mockTables();

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const link = screen.getByTestId('staging-item-contract-link');
    expect(link).toHaveAttribute('href', '/rental/contracts/contract-001');
  });

  // ── Exception queue ────────────────────────────────────────────────────────

  it('renders a blocking exception card for a missing contact', async () => {
    mockTables({
      // clearing contact_name and delivery_contact guarantees the missing_contact exception fires
      contracts: [makeContract('contract-001', { contact_name: '', delivery_contact: '' })],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const exceptions = screen.getAllByTestId('staging-exception');
    expect(exceptions.length).toBeGreaterThan(0);
    expect(exceptions[0]).toHaveTextContent('Missing delivery contact');
    expect(exceptions[0]).toHaveTextContent('Blocking');
  });

  it('shows required-action text inside each exception card', async () => {
    mockTables({
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    expect(screen.getByText('Required action')).toBeInTheDocument();
    expect(screen.getByText(/Capture the site contact/i)).toBeInTheDocument();
  });

  it('renders evidence fields inside an exception card', async () => {
    mockTables({
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const exceptionCard = screen.getAllByTestId('staging-exception')[0];
    expect(exceptionCard).toHaveTextContent('Contract');
    expect(exceptionCard).toHaveTextContent('RC-001');
  });

  it('renders a warning exception for a yard-not-staged asset', async () => {
    // Yard row is absent so yard_not_staged warning fires
    mockTables({ yardRows: [] });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    // Title of the yard_not_staged exception card
    expect(screen.getByText('Asset not yet staged in the yard')).toBeInTheDocument();
    // The exception card for that title should carry a Warning badge
    const exceptions = screen.getAllByTestId('staging-exception');
    const yardException = exceptions.find((el) =>
      el.textContent?.includes('Asset not yet staged in the yard'),
    );
    expect(yardException).toBeDefined();
    expect(yardException).toHaveTextContent('Warning');
  });

  it('renders a contract link on exception cards', async () => {
    mockTables({
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const exceptionLink = screen.getAllByTestId('staging-exception-link')[0];
    expect(exceptionLink).toHaveAttribute('href', '/rental/contracts/contract-001');
  });

  // ── Operating-model badges ─────────────────────────────────────────────────

  it('renders both operating-model badges inside the staging panel', async () => {
    mockTables();

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    expect(screen.getByText('yard-logistics-coordinator:t2')).toBeInTheDocument();
    expect(screen.getByText('yard-logistics-coordinator:t4')).toBeInTheDocument();
  });

  // ── Multi-line same-contract behaviour ────────────────────────────────────

  it('renders two staging items when two pending lines share a contract', async () => {
    mockTables({
      dispatchLines: [
        makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001' }),
        makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002' }),
      ],
      yardRows: [makeYardRow('asset-001'), makeYardRow('asset-002')],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const items = screen.getAllByTestId('staging-item');
    expect(items).toHaveLength(2);
  });

  it('surfaces yard_not_staged warning only for the unstaged asset when one of two contract lines is absent from going_out', async () => {
    mockTables({
      dispatchLines: [
        makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001' }),
        makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002' }),
      ],
      // Only asset-001 staged; asset-002 is not in going_out
      yardRows: [makeYardRow('asset-001')],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    // Both staging items must appear
    const items = screen.getAllByTestId('staging-item');
    expect(items).toHaveLength(2);

    // Exactly one yard exception (for asset-002)
    const exceptions = screen.getAllByTestId('staging-exception');
    const yardExceptions = exceptions.filter((el) =>
      el.textContent?.includes('Asset not yet staged in the yard'),
    );
    expect(yardExceptions).toHaveLength(1);
  });

  it('staged line does not inherit sibling yard_not_staged — exception badge absent from staged item', async () => {
    // asset-001 is staged (in going_out); asset-002 is not.
    // The staged item must show no exception badge; the unstaged item shows "1 exception".
    mockTables({
      dispatchLines: [
        makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001', data: { planned_start: new Date().toISOString().slice(0, 10), asset_name: 'Excavator A', category_name: 'Excavators' } }),
        makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002', data: { planned_start: new Date().toISOString().slice(0, 10), asset_name: 'Excavator B', category_name: 'Excavators' } }),
      ],
      // Only asset-001 is staged
      yardRows: [makeYardRow('asset-001')],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const items = screen.getAllByTestId('staging-item');
    expect(items).toHaveLength(2);

    // Find the staged item (Excavator A) and unstaged item (Excavator B) by asset name
    const stagedItem = items.find((el) => el.textContent?.includes('Excavator A'));
    const unstagedItem = items.find((el) => el.textContent?.includes('Excavator B'));

    expect(stagedItem).toBeDefined();
    expect(unstagedItem).toBeDefined();

    // Staged item: no exception badge at all
    expect(stagedItem?.textContent).not.toMatch(/\d+ exception/);

    // Unstaged item: shows "1 exception" badge from yard_not_staged warning
    expect(unstagedItem?.textContent).toMatch(/1 exception/);
  });

  // ── Summary badges ─────────────────────────────────────────────────────────

  it('shows "No exceptions" summary badge when all lines are ready', async () => {
    mockTables();

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    expect(screen.getByText('No exceptions')).toBeInTheDocument();
  });

  it('shows a blocking-exception count badge when blocking exceptions exist', async () => {
    mockTables({
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    // Badge reads "1 blocking exception"; use exact match to avoid matching the CardDescription prose
    expect(screen.getByText('1 blocking exception')).toBeInTheDocument();
  });

  // ── Current-version SCD2 correctness ─────────────────────────────────────

  it('queries entities with is_current entity_version — shows no exception when current version is complete', async () => {
    // entities query with entity_versions!inner(data, is_current) + .eq('entity_versions.is_current', true)
    // returns the current-version row. All fields populated → no exception fires.
    mockTables({
      contracts: [makeContract('contract-001')], // all fields complete
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    expect(screen.queryByTestId('staging-exception')).not.toBeInTheDocument();
    expect(screen.getByText('No exceptions')).toBeInTheDocument();
  });

  it('fires a blocking exception when the is_current entity_version has no contact', async () => {
    // The is_current entity_version lacks contact fields → blocking exception renders.
    mockTables({
      contracts: [makeContract('contract-001', {
        contact_name: '',
        customer_id: '',
        delivery_contact: '',
      })],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    const exceptions = screen.getAllByTestId('staging-exception');
    const contactEx = exceptions.find((el) =>
      el.textContent?.includes('Missing delivery contact'),
    );
    expect(contactEx).toBeDefined();
    expect(contactEx).toHaveTextContent('Blocking');
  });

  it('does not use a stale non-current version when it appears before the current one', async () => {
    // Simulates Supabase returning entity_versions where the first element has is_current: false
    // (stale, with a missing contact) and the second has is_current: true (current, complete).
    // contractVersionData() must pick the is_current: true row, not entity_versions[0].
    mockTables({
      contracts: [{
        id: 'contract-001',
        entity_versions: [
          {
            is_current: false,
            data: {
              // Stale version — missing contact would fire an exception if incorrectly used
              contract_number: 'RC-001',
              status: 'active',
              contact_name: '',
              customer_id: '',
              customer_name: '',
              delivery_address: '123 Main St, Springfield',              job_site_id: 'site-001',
              job_site_name: '',
              branch_id: '',
              delivery_instructions: 'Call before arrival.',
            },
          },
          {
            is_current: true,
            data: {
              // Current version — fully populated, no exception should fire
              contract_number: 'RC-001',
              status: 'active',
              customer_id: 'cust-001',
              customer_name: 'Acme Construction',
              contact_name: 'Jane Doe',
              delivery_address: '123 Main St, Springfield',
              job_site_id: 'site-001',
              job_site_name: 'Primary Site',
              branch_id: 'branch-001',
              delivery_instructions: 'Call before arrival.',
            },
          },
        ],
      }],
    });

    render(<PredispatchStagingScreen />);

    await screen.findByTestId('predispatch-staging-panel');

    // The current version is complete — no contact exception should be present
    expect(screen.queryByText('Missing delivery contact')).not.toBeInTheDocument();
    expect(screen.getByText('No exceptions')).toBeInTheDocument();
  });
});
