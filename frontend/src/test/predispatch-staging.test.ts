import { describe, expect, it } from 'vitest';
import { buildPredispatchStagingList, PREDISPATCH_STAGING_TAGS } from '@/lib/predispatch-staging';

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
      customer_name: 'Acme Construction',
      job_site_name: 'Site Alpha',
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
        delivery_instructions: 'Call before arrival.',
        branch_id: 'branch-001',
        ...dataOverrides,
      },
    }],
  };
}

function makeYardRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: 'activity-001',
    lane_key: 'going_out',
    contract_id: 'contract-001',
    contract_line_id: 'line-001',
    asset_id: 'asset-001',
    asset_name: 'Excavator 320',
    asset_category_name: 'Excavators',
    job_site_id: 'site-001',
    job_site_name: 'Site Alpha',
    customer_name: 'Acme Construction',
    branch_id: 'branch-001',
    scheduled_start_at: null,
    sort_at: null,
    ...overrides,
  };
}

describe('buildPredispatchStagingList', () => {
  // ── No-op behaviour ────────────────────────────────────────────────────────

  it('returns noOp:true when no lines and no contracts are provided', () => {
    const result = buildPredispatchStagingList({});
    expect(result.noOp).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(result.exceptions).toHaveLength(0);
    expect(result.tags).toEqual(PREDISPATCH_STAGING_TAGS);
  });

  it('returns noOp:true when dispatch lines are empty', () => {
    const result = buildPredispatchStagingList({ dispatchLines: [], contracts: [] });
    expect(result.noOp).toBe(true);
  });

  it('returns noOp:true for lines outside the 2-day dispatch window', () => {
    const farFuture = '2099-12-31';
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine({ data: { planned_start: farFuture } })],
      contracts: [makeContract()],
      today: '2026-01-01',
    });
    expect(result.noOp).toBe(true);
  });

  // ── Staging item assembly ──────────────────────────────────────────────────

  it('builds a staging item for a fully-ready line with no exceptions', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract()],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.noOp).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].contractNumber).toBe('RC-001');
    expect(result.items[0].readyToStage).toBe(true);
    expect(result.items[0].exceptionCount).toBe(0);
    expect(result.exceptions).toHaveLength(0);
  });

  it('marks a staging item as blocked when a blocking exception exists', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.noOp).toBe(false);
    expect(result.items[0].readyToStage).toBe(false);
    const blocking = result.exceptions.filter((e) => e.severity === 'blocking');
    expect(blocking.length).toBeGreaterThan(0);
  });

  // ── Exception: missing contact ─────────────────────────────────────────────

  it('detects missing_contact exception when no contact fields are present', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '', delivery_contact: '' })],
      today: new Date().toISOString().slice(0, 10),
    });

    const ex = result.exceptions.find((e) => e.code === 'missing_contact');
    expect(ex).toBeDefined();
    expect(ex?.severity).toBe('blocking');
    expect(ex?.contractNumber).toBe('RC-001');
    expect(ex?.evidence.some((ev) => ev.label === 'Contract')).toBe(true);
    expect(ex?.tags).toContain('yard-logistics-coordinator:t2');
  });

  it('raises missing_contact when only customer_id is present but no real contact field', () => {
    // customer_id is an entity reference, not a delivery contact; it must not suppress the exception
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: 'cust-001', delivery_contact: '' })],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.exceptions.find((e) => e.code === 'missing_contact')).toBeDefined();
  });

  // ── Exception: missing address ─────────────────────────────────────────────

  it('detects missing_address exception when no address or job site is present', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { job_site_id: '', delivery_address: '', delivery_city: '' })],
      today: new Date().toISOString().slice(0, 10),
    });

    const ex = result.exceptions.find((e) => e.code === 'missing_address');
    expect(ex).toBeDefined();
    expect(ex?.severity).toBe('blocking');
    expect(ex?.tags).toContain('yard-logistics-coordinator:t2');
  });

  it('does not raise missing_address when job_site_id is present', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { job_site_id: 'site-001', delivery_address: '' })],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.exceptions.find((e) => e.code === 'missing_address')).toBeUndefined();
  });

  // ── Exception: missing delivery instructions ───────────────────────────────

  it('raises missing_delivery_instructions warning when no instructions are recorded', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { delivery_instructions: '', notes: '', special_instructions: '' })],
      today: new Date().toISOString().slice(0, 10),
    });

    const ex = result.exceptions.find((e) => e.code === 'missing_delivery_instructions');
    expect(ex).toBeDefined();
    expect(ex?.severity).toBe('warning');
    expect(ex?.tags).toContain('yard-logistics-coordinator:t2');
  });

  it('does not raise missing_delivery_instructions when notes are present', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { delivery_instructions: '', notes: 'Arrive at 8am.' })],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.exceptions.find((e) => e.code === 'missing_delivery_instructions')).toBeUndefined();
  });

  // ── Exception: contract not ready ─────────────────────────────────────────

  it('raises contract_not_ready blocking exception for a cancelled contract', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { status: 'cancelled' })],
      today: new Date().toISOString().slice(0, 10),
    });

    const ex = result.exceptions.find((e) => e.code === 'contract_not_ready');
    expect(ex).toBeDefined();
    expect(ex?.severity).toBe('blocking');
    expect(ex?.evidence.find((ev) => ev.label === 'Current status')?.value).toBe('cancelled');
    expect(ex?.tags).toContain('yard-logistics-coordinator:t4');
  });

  it('does not raise contract_not_ready for active contracts', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { status: 'active' })],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.exceptions.find((e) => e.code === 'contract_not_ready')).toBeUndefined();
  });

  it('does not raise contract_not_ready for pending_execution contracts', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { status: 'pending_execution' })],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.exceptions.find((e) => e.code === 'contract_not_ready')).toBeUndefined();
  });

  // ── Exception: yard not staged ─────────────────────────────────────────────

  it('raises yard_not_staged warning when the asset has no going_out yard entry', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract()],
      yardReadiness: [],
      today: new Date().toISOString().slice(0, 10),
    });

    const ex = result.exceptions.find((e) => e.code === 'yard_not_staged');
    expect(ex).toBeDefined();
    expect(ex?.severity).toBe('warning');
    expect(ex?.evidence.find((ev) => ev.label === 'Asset ID')?.value).toBe('asset-001');
    expect(ex?.tags).toContain('yard-logistics-coordinator:t4');
  });

  it('does not raise yard_not_staged when the asset appears in the going_out lane', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract()],
      yardReadiness: [makeYardRow({ asset_id: 'asset-001' })],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.exceptions.find((e) => e.code === 'yard_not_staged')).toBeUndefined();
  });

  it('ignores yard rows not in the going_out lane', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract()],
      yardReadiness: [makeYardRow({ lane_key: 'maintenance', asset_id: 'asset-001' })],
      today: new Date().toISOString().slice(0, 10),
    });

    const ex = result.exceptions.find((e) => e.code === 'yard_not_staged');
    expect(ex).toBeDefined();
  });

  // ── Multi-line same-contract behaviour ────────────────────────────────────

  it('produces two staging items for two lines on the same contract', () => {
    const today = new Date().toISOString().slice(0, 10);
    const line1 = makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001' });
    const line2 = makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002' });

    const result = buildPredispatchStagingList({
      dispatchLines: [line1, line2],
      contracts: [makeContract()],
      yardReadiness: [makeYardRow({ asset_id: 'asset-001' }), makeYardRow({ asset_id: 'asset-002' })],
      today,
    });

    expect(result.items).toHaveLength(2);
  });

  it('surfaces yard_not_staged only for the unstaged asset when one of two contract lines is not in going_out', () => {
    const today = new Date().toISOString().slice(0, 10);
    const line1 = makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001' });
    const line2 = makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002' });
    // Only asset-001 is staged in going_out; asset-002 is not
    const yardRow = makeYardRow({ asset_id: 'asset-001' });

    const result = buildPredispatchStagingList({
      dispatchLines: [line1, line2],
      contracts: [makeContract()],
      yardReadiness: [yardRow],
      today,
    });

    expect(result.items).toHaveLength(2);
    const yardExceptions = result.exceptions.filter((e) => e.code === 'yard_not_staged');
    expect(yardExceptions).toHaveLength(1);
    expect(yardExceptions[0].evidence.find((ev) => ev.label === 'Asset ID')?.value).toBe('asset-002');
  });

  it('staged line does not inherit sibling yard_not_staged warning — exceptionCount and readyToStage are scoped per asset', () => {
    const today = new Date().toISOString().slice(0, 10);
    const line1 = makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001' });
    const line2 = makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002' });
    // asset-001 is in going_out (staged); asset-002 is not
    const yardRow = makeYardRow({ asset_id: 'asset-001' });

    const result = buildPredispatchStagingList({
      dispatchLines: [line1, line2],
      contracts: [makeContract()],
      yardReadiness: [yardRow],
      today,
    });

    expect(result.items).toHaveLength(2);
    const stagedItem = result.items.find((i) => i.assetId === 'asset-001');
    const unstageddItem = result.items.find((i) => i.assetId === 'asset-002');
    // Staged asset: no yard exception → ready, exceptionCount = 0
    expect(stagedItem?.readyToStage).toBe(true);
    expect(stagedItem?.exceptionCount).toBe(0);
    // Unstaged asset: yard_not_staged warning → not blocked but has 1 exception
    expect(unstageddItem?.readyToStage).toBe(true);
    expect(unstageddItem?.exceptionCount).toBe(1);
  });

  it('produces two yard_not_staged exceptions when both assets on a contract are unstaged', () => {
    const today = new Date().toISOString().slice(0, 10);
    const line1 = makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001' });
    const line2 = makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002' });

    const result = buildPredispatchStagingList({
      dispatchLines: [line1, line2],
      contracts: [makeContract()],
      yardReadiness: [],
      today,
    });

    expect(result.items).toHaveLength(2);
    const yardExceptions = result.exceptions.filter((e) => e.code === 'yard_not_staged');
    expect(yardExceptions).toHaveLength(2);
    const assetIds = yardExceptions.map((e) => e.evidence.find((ev) => ev.label === 'Asset ID')?.value);
    expect(assetIds).toContain('asset-001');
    expect(assetIds).toContain('asset-002');
  });

  it('dedupes contract-scoped exceptions but not yard exceptions across two lines', () => {
    const today = new Date().toISOString().slice(0, 10);
    const line1 = makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001' });
    const line2 = makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002' });

    const result = buildPredispatchStagingList({
      dispatchLines: [line1, line2],
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
      yardReadiness: [],
      today,
    });

    // One contact exception (contract-scoped, deduped) and two yard exceptions (per-asset)
    expect(result.exceptions.filter((e) => e.code === 'missing_contact')).toHaveLength(1);
    expect(result.exceptions.filter((e) => e.code === 'yard_not_staged')).toHaveLength(2);
    expect(result.items).toHaveLength(2);
  });

  // ── Duplicate-collapse ─────────────────────────────────────────────────────

  it('collapses duplicate exceptions for the same contract across multiple lines', () => {
    const today = new Date().toISOString().slice(0, 10);
    const line1 = makeDispatchLine({ entity_id: 'line-001', asset_id: 'asset-001' });
    const line2 = makeDispatchLine({ entity_id: 'line-002', asset_id: 'asset-002' });
    const contract = makeContract('contract-001', { contact_name: '', customer_id: '' });

    const result = buildPredispatchStagingList({
      dispatchLines: [line1, line2],
      contracts: [contract],
      today,
    });

    const contactExceptions = result.exceptions.filter((e) => e.code === 'missing_contact');
    expect(contactExceptions).toHaveLength(1);
  });

  it('does not collapse exceptions across different contracts', () => {
    const today = new Date().toISOString().slice(0, 10);
    const line1 = makeDispatchLine({ entity_id: 'line-001', contract_id: 'contract-001' });
    const line2 = makeDispatchLine({ entity_id: 'line-002', contract_id: 'contract-002' });
    const contract1 = makeContract('contract-001', { contact_name: '', customer_id: '' });
    const contract2 = { id: 'contract-002', entity_versions: [{ is_current: true, data: { contract_number: 'RC-002', status: 'active', customer_name: 'Other Co', contact_name: '', customer_id: '' } }] };

    const result = buildPredispatchStagingList({
      dispatchLines: [line1, line2],
      contracts: [contract1, contract2],
      today,
    });

    const contactExceptions = result.exceptions.filter((e) => e.code === 'missing_contact');
    expect(contactExceptions.length).toBeLessThanOrEqual(2);

    const allContactExceptions = result.exceptions.filter((e) => e.code === 'missing_contact');
    expect(allContactExceptions).toHaveLength(2);
  });

  // ── Evidence integrity ─────────────────────────────────────────────────────

  it('preserves source evidence for each exception', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
      today: new Date().toISOString().slice(0, 10),
    });

    const ex = result.exceptions.find((e) => e.code === 'missing_contact');
    expect(ex?.evidence.length).toBeGreaterThan(0);
    expect(ex?.evidence.every((ev) => ev.label && ev.value)).toBe(true);
    expect(ex?.routeHref).toContain('/rental/contracts/');
  });

  // ── Exception sort order ───────────────────────────────────────────────────

  it('sorts blocking exceptions before warnings', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '', delivery_instructions: '' })],
      yardReadiness: [],
      today: new Date().toISOString().slice(0, 10),
    });

    const severities = result.exceptions.map((e) => e.severity);
    const firstWarningIndex = severities.indexOf('warning');
    const lastBlockingIndex = [...severities].reverse().indexOf('blocking');
    if (firstWarningIndex !== -1 && lastBlockingIndex !== -1) {
      expect(severities.length - 1 - lastBlockingIndex).toBeLessThan(firstWarningIndex);
    }
  });

  // ── Items sort order ───────────────────────────────────────────────────────

  it('places blocked items before ready items in the staging queue', () => {
    const today = new Date().toISOString().slice(0, 10);
    const blockedLine = makeDispatchLine({ entity_id: 'line-a', contract_id: 'contract-a' });
    const readyLine = makeDispatchLine({ entity_id: 'line-b', contract_id: 'contract-b' });
    const blockedContract = { id: 'contract-a', entity_versions: [{ is_current: true, data: { contract_number: 'RC-A', status: 'active', contact_name: '', customer_id: '' } }] };
    const readyContract = makeContract('contract-b', { contract_number: 'RC-B' });

    const result = buildPredispatchStagingList({
      dispatchLines: [readyLine, blockedLine],
      contracts: [readyContract, blockedContract],
      yardReadiness: [makeYardRow({ contract_id: 'contract-b', asset_id: 'asset-001' })],
      today,
    });

    const firstItem = result.items[0];
    expect(firstItem.readyToStage).toBe(false);
  });

  // ── Operating model tags ───────────────────────────────────────────────────

  it('includes the required operating model tags on the result', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract()],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.tags).toContain('yard-logistics-coordinator:t2');
    expect(result.tags).toContain('yard-logistics-coordinator:t4');
  });

  it('includes t2 tag on contact/address/instructions exceptions', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { contact_name: '', customer_id: '' })],
      today: new Date().toISOString().slice(0, 10),
    });

    const contactEx = result.exceptions.find((e) => e.code === 'missing_contact');
    expect(contactEx?.tags).toContain('yard-logistics-coordinator:t2');
  });

  it('includes t4 tag on contract_not_ready and yard_not_staged exceptions', () => {
    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [makeContract('contract-001', { status: 'on_hold' })],
      yardReadiness: [],
      today: new Date().toISOString().slice(0, 10),
    });

    const contractEx = result.exceptions.find((e) => e.code === 'contract_not_ready');
    expect(contractEx?.tags).toContain('yard-logistics-coordinator:t4');

    const yardEx = result.exceptions.find((e) => e.code === 'yard_not_staged');
    expect(yardEx?.tags).toContain('yard-logistics-coordinator:t4');
  });

  // ── Current-version SCD2 correctness ──────────────────────────────────────

  it('reads the is_current entity_version — no exceptions when the current version is complete', () => {
    // Simulates entities with entity_versions!inner(data, is_current).
    // The is_current row has complete data so no exception fires.
    const currentRow = {
      id: 'contract-001',
      entity_versions: [{
        is_current: true,
        data: {
          contract_number: 'RC-001',
          status: 'active',
          customer_id: 'cust-001',
          contact_name: 'Current Contact',
          delivery_address: '123 Main St',
          job_site_id: 'site-001',
          delivery_instructions: 'Call before arrival.',
        },
      }],
    };

    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [currentRow],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    expect(result.exceptions).toHaveLength(0);
    expect(result.items[0].readyToStage).toBe(true);
    expect(result.items[0].contractNumber).toBe('RC-001');
  });

  it('fires a blocking exception when the is_current entity_version has a missing contact', () => {
    // Current version row has no contact — exception must fire based on this version.
    const currentRow = {
      id: 'contract-001',
      entity_versions: [{
        is_current: true,
        data: {
          contract_number: 'RC-001',
          status: 'active',
          contact_name: '',
          customer_id: '',
          delivery_contact: '',
          delivery_address: '123 Main St',
          job_site_id: 'site-001',
          delivery_instructions: 'Call before arrival.',
        },
      }],
    };

    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [currentRow],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    const contactEx = result.exceptions.find((e) => e.code === 'missing_contact');
    expect(contactEx).toBeDefined();
    expect(result.items[0].readyToStage).toBe(false);
  });

  it('ignores a row whose id does not match any dispatch line contract_id', () => {
    // A row with a different id is never keyed to the line's contract and is ignored.
    const today = new Date().toISOString().slice(0, 10);
    const line = makeDispatchLine({ entity_id: 'line-001', contract_id: 'contract-current' });

    const currentRow = {
      id: 'contract-current',
      entity_versions: [{
        is_current: true,
        data: {
          contract_number: 'RC-LIVE',
          status: 'active',
          customer_id: 'cust-001',
          contact_name: 'Live Contact',
          delivery_address: '123 Main St',
          job_site_id: 'site-001',
          delivery_instructions: 'Arrive at gate 2.',
        },
      }],
    };
    const unrelatedRow = {
      id: 'contract-unrelated',
      entity_versions: [{
        is_current: true,
        data: {
          contract_number: 'RC-OTHER',
          status: 'cancelled',
          contact_name: '',
          customer_id: '',
          delivery_address: '',
          job_site_id: '',
          delivery_instructions: '',
        },
      }],
    };

    const result = buildPredispatchStagingList({
      dispatchLines: [line],
      contracts: [currentRow, unrelatedRow],
      yardReadiness: [makeYardRow({ asset_id: 'asset-001' })],
      today,
    });

    expect(result.items[0].contractNumber).toBe('RC-LIVE');
    expect(result.exceptions).toHaveLength(0);
    expect(result.items[0].readyToStage).toBe(true);
  });

  it('uses the is_current version — stale non-current version first does not pollute staging', () => {
    // Simulates Supabase returning entity_versions where is_current: false appears before
    // is_current: true. contractVersionData() must pick the is_current: true row, not [0].
    const today = new Date().toISOString().slice(0, 10);
    const contractRow = {
      id: 'contract-001',
      entity_versions: [
        {
          is_current: false,
          data: {
            // Stale version — missing contact fields that would fire an exception if used
            contract_number: 'RC-001',
            status: 'active',
            contact_name: '',
            customer_id: '',
            delivery_contact: '',
            delivery_address: '123 Main St',
            job_site_id: 'site-001',
            delivery_instructions: 'Call before arrival.',
          },
        },
        {
          is_current: true,
          data: {
            // Current version — fully populated, no exceptions should fire
            contract_number: 'RC-001',
            status: 'active',
            customer_id: 'cust-001',
            contact_name: 'Live Contact',
            delivery_address: '123 Main St',
            job_site_id: 'site-001',
            delivery_instructions: 'Call before arrival.',
          },
        },
      ],
    };

    const result = buildPredispatchStagingList({
      dispatchLines: [makeDispatchLine()],
      contracts: [contractRow],
      yardReadiness: [makeYardRow()],
      today,
    });

    // The current version has all required fields — no exceptions should fire
    expect(result.exceptions.filter((e) => e.code === 'missing_contact')).toHaveLength(0);
    expect(result.items[0].readyToStage).toBe(true);
  });

  // ── Contract number fallback (UUID-safety) ────────────────────────────────

  it('produces a non-UUID contractNumber when contract_number is absent — uses short suffix of contractId', () => {
    const contractId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const line = makeDispatchLine({ contract_id: contractId });
    const contractRow = {
      id: contractId,
      entity_versions: [{
        is_current: true,
        data: {
          // No contract_number — the fallback must not expose the raw UUID
          status: 'active',
          customer_id: 'cust-001',
          contact_name: 'Jane Doe',
          delivery_address: '1 Main St',
          job_site_id: 'site-001',
          delivery_instructions: 'Call ahead.',
        },
      }],
    };

    const result = buildPredispatchStagingList({
      dispatchLines: [line],
      contracts: [contractRow],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const { contractNumber } = result.items[0];
    expect(contractNumber, 'contractNumber must be non-empty').toBeTruthy();
    expect(
      rawUuidPattern.test(contractNumber),
      `contractNumber must not be a raw UUID — got: "${contractNumber}"`
    ).toBe(false);
    // The fallback is expected to encode the last 6 chars of the contractId
    expect(contractNumber).toContain(contractId.slice(-6).toUpperCase());
  });

  it('exception contractNumber is also non-UUID when contract_number is absent', () => {
    const contractId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const line = makeDispatchLine({ contract_id: contractId });
    // Trigger a missing_contact exception via a contract with no contact
    const contractRow = {
      id: contractId,
      entity_versions: [{
        is_current: true,
        data: {
          status: 'active',
          customer_id: 'cust-001',
          contact_name: '',
          delivery_contact: '',
          delivery_address: '1 Main St',
          job_site_id: 'site-001',
          delivery_instructions: 'Call ahead.',
        },
      }],
    };

    const result = buildPredispatchStagingList({
      dispatchLines: [line],
      contracts: [contractRow],
      yardReadiness: [makeYardRow()],
      today: new Date().toISOString().slice(0, 10),
    });

    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const contactEx = result.exceptions.find((e) => e.code === 'missing_contact');
    expect(contactEx, 'missing_contact exception must fire').toBeDefined();
    const { contractNumber } = contactEx!;
    expect(contractNumber, 'exception contractNumber must be non-empty').toBeTruthy();
    expect(
      rawUuidPattern.test(contractNumber),
      `exception contractNumber must not be a raw UUID — got: "${contractNumber}"`
    ).toBe(false);
  });
});
