import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { fromMock, getPublicUrlMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  getPublicUrlMock: vi.fn((path: string) => ({
    data: { publicUrl: `https://storage.mock/field-evidence/${path}` },
  })),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: getPublicUrlMock,
      })),
    },
  },
}));

import {
  buildCustomerRecap,
  buildCustomerRecapShareText,
  buildConditionDelta,
  buildChecklistVariance,
  InspectionComparisonScreen,
  type InspectionRecord,
} from '@/routes/rental/inspection-comparison';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeInspection(overrides: Partial<InspectionRecord> = {}): InspectionRecord {
  return {
    entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
    createdAt: '2026-06-01T09:00:00.000Z',
    data: {
      asset_id: 'asset-1',
      contract_line_id: 'line-1',
      inspection_type: 'checkout',
      outcome: 'pass',
      resulting_asset_status: 'on_rent',
      inspected_at: '2026-06-01T09:00:00.000Z',
      notes: 'Internal tech note — must not appear in recap',
      evidence: {
        signature: 'Operator Name',
        signature_confirmed: true,
        approval_status: 'approved',
        notes: 'Internal evidence note — must not appear in recap',
        meter_reading: 1200,
        meter_unit: 'hrs',
        fuel_level_pct: 80,
        location: '37.7749,-122.4194',
        photo_paths: ['line-1/photo-a.jpg', 'line-1/photo-b.jpg'],
        checklist_items: [
          { item: 'Tyres', status: 'pass' },
          { item: 'Lights', status: 'pass' },
          { item: 'Hydraulics', status: 'na' },
        ],
      },
    },
    ...overrides,
  };
}

function makeReturnInspection(overrides: Partial<InspectionRecord> = {}): InspectionRecord {
  return makeInspection({
    entityId: 'bbbbbbbb-0000-4000-8000-000000000002',
    createdAt: '2026-06-10T15:00:00.000Z',
    data: {
      asset_id: 'asset-1',
      contract_line_id: 'line-1',
      inspection_type: 'return',
      outcome: 'fail',
      resulting_asset_status: 'on_inspection_hold',
      inspected_at: '2026-06-10T15:00:00.000Z',
      notes: 'Return internal damage note — must not appear in recap',
      evidence: {
        signature: 'Return Operator',
        signature_confirmed: true,
        approval_status: 'approved',
        notes: 'Internal return evidence note — must not appear in recap',
        meter_reading: 1450,
        meter_unit: 'hrs',
        fuel_level_pct: 30,
        location: '37.7749,-122.4194',
        photo_paths: ['line-1/return-photo-a.jpg'],
        checklist_items: [
          { item: 'Tyres', status: 'fail' },
          { item: 'Lights', status: 'pass' },
          { item: 'Hydraulics', status: 'fail' },
        ],
      },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// buildCustomerRecap — customer-safe content filtering
// ---------------------------------------------------------------------------
describe('buildCustomerRecap', () => {
  it('includes inspection outcome, status, timestamp, signature, photos, meter, fuel', () => {
    const inspection = makeInspection();
    const recap = buildCustomerRecap(inspection);

    expect(recap.outcome).toBe('pass');
    expect(recap.resultingAssetStatus).toBe('on_rent');
    expect(recap.inspectionType).toBe('checkout');
    expect(recap.signatureCaptured).toBe(true);
    expect(recap.photoCount).toBe(2);
    expect(recap.meterReading).toBe(1200);
    expect(recap.meterUnit).toBe('hrs');
    expect(recap.fuelLevelPct).toBe(80);
    expect(recap.location).toBe('37.7749,-122.4194');
    expect(recap.auditRef).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('excludes internal notes fields from the recap', () => {
    const inspection = makeInspection();
    const recap = buildCustomerRecap(inspection);

    // The returned object should not contain any field with 'notes' value
    const recapValues = Object.values(recap as Record<string, unknown>);
    expect(recapValues).not.toContain('Internal tech note — must not appear in recap');
    expect(recapValues).not.toContain('Internal evidence note — must not appear in recap');
    expect(recap).not.toHaveProperty('notes');
  });

  it('returns stable auditRef equal to the entity ID', () => {
    const inspection = makeInspection({ entityId: 'cccccccc-1111-4000-8000-000000000003' });
    expect(buildCustomerRecap(inspection).auditRef).toBe('cccccccc-1111-4000-8000-000000000003');
  });

  it('reports signatureCaptured=false when evidence has no confirmed signature', () => {
    const inspection = makeInspection();
    inspection.data.evidence = { signature_confirmed: false };
    expect(buildCustomerRecap(inspection).signatureCaptured).toBe(false);
  });

  it('reports signatureCaptured=false when evidence is null', () => {
    const inspection = makeInspection();
    inspection.data.evidence = null;
    expect(buildCustomerRecap(inspection).signatureCaptured).toBe(false);
  });

  it('reports photoCount=0 when no photos are present', () => {
    const inspection = makeInspection();
    inspection.data.evidence = {};
    expect(buildCustomerRecap(inspection).photoCount).toBe(0);
  });

  it('reports null for optional numeric fields when absent', () => {
    const inspection = makeInspection();
    inspection.data.evidence = { signature_confirmed: true, photo_paths: [] };
    const recap = buildCustomerRecap(inspection);
    expect(recap.meterReading).toBeNull();
    expect(recap.fuelLevelPct).toBeNull();
    expect(recap.location).toBeNull();
  });

  it('falls back to entity createdAt when inspected_at is absent', () => {
    const inspection = makeInspection();
    delete inspection.data.inspected_at;
    const recap = buildCustomerRecap(inspection);
    expect(recap.inspectedAt).toBe('2026-06-01T09:00:00.000Z');
  });

  it('builds share text with timestamps and audit refs while excluding internal notes', () => {
    const shareText = buildCustomerRecapShareText(makeInspection(), makeReturnInspection());

    expect(shareText).toContain('Customer Inspection Recap');
    expect(shareText).toContain('Pickup / Checkout Inspection');
    expect(shareText).toContain('Return Inspection');
    expect(shareText).toContain('Date / time: 2026-06-01T09:00:00.000Z');
    expect(shareText).toContain('Date / time: 2026-06-10T15:00:00.000Z');
    expect(shareText).toContain('Audit ref: aaaaaaaa-0000-4000-8000-000000000001');
    expect(shareText).toContain('Audit ref: bbbbbbbb-0000-4000-8000-000000000002');
    expect(shareText).toContain(
      'Audit references: aaaaaaaa-0000-4000-8000-000000000001, bbbbbbbb-0000-4000-8000-000000000002',
    );
    expect(shareText).not.toContain('Internal tech note — must not appear in recap');
    expect(shareText).not.toContain('Internal evidence note — must not appear in recap');
    expect(shareText).not.toContain('Return internal damage note — must not appear in recap');
    expect(shareText).not.toContain('Internal return evidence note — must not appear in recap');
  });
});

// ---------------------------------------------------------------------------
// buildConditionDelta — comparison rendering tests
// ---------------------------------------------------------------------------
describe('buildConditionDelta', () => {
  it('reports all unchanged when pickup and return have identical key fields', () => {
    const pickup = makeInspection();
    const ret = makeInspection({
      entityId: 'dddddddd-0000-4000-8000-000000000004',
      data: {
        ...makeInspection().data,
        inspection_type: 'return',
      },
    });
    const delta = buildConditionDelta(pickup, ret);

    expect(delta.outcomeChanged).toBe(false);
    expect(delta.meterChanged).toBe(false);
    expect(delta.fuelChanged).toBe(false);
    expect(delta.photoCountChanged).toBe(false);
    expect(delta.signatureChanged).toBe(false);
  });

  it('flags outcomeChanged when outcome differs between pickup and return', () => {
    const pickup = makeInspection();
    const ret = makeReturnInspection();
    const delta = buildConditionDelta(pickup, ret);

    expect(delta.outcomeChanged).toBe(true);
  });

  it('flags meterChanged when meter reading differs', () => {
    const pickup = makeInspection();
    const ret = makeReturnInspection();
    const delta = buildConditionDelta(pickup, ret);

    expect(delta.meterChanged).toBe(true);
  });

  it('flags fuelChanged when fuel level differs', () => {
    const pickup = makeInspection();
    const ret = makeReturnInspection();
    const delta = buildConditionDelta(pickup, ret);

    expect(delta.fuelChanged).toBe(true);
  });

  it('flags photoCountChanged when photo count differs', () => {
    const pickup = makeInspection(); // 2 photos
    const ret = makeReturnInspection(); // 1 photo
    const delta = buildConditionDelta(pickup, ret);

    expect(delta.photoCountChanged).toBe(true);
  });

  it('does NOT flag photoCountChanged when both have same photo count', () => {
    const pickup = makeInspection();
    const ret = makeReturnInspection();
    if (ret.data.evidence) ret.data.evidence.photo_paths = ['a.jpg', 'b.jpg'];
    const delta = buildConditionDelta(pickup, ret);

    expect(delta.photoCountChanged).toBe(false);
  });

  it('does NOT flag signatureChanged when both have confirmed signatures', () => {
    const pickup = makeInspection();
    const ret = makeReturnInspection();
    const delta = buildConditionDelta(pickup, ret);

    expect(delta.signatureChanged).toBe(false);
  });

  it('flags signatureChanged when one side is missing a confirmed signature', () => {
    const pickup = makeInspection();
    pickup.data.evidence = { signature_confirmed: false };
    const ret = makeReturnInspection();
    const delta = buildConditionDelta(pickup, ret);

    expect(delta.signatureChanged).toBe(true);
  });

  it('returns all false when either side is null', () => {
    const delta1 = buildConditionDelta(null, makeReturnInspection());
    expect(Object.values(delta1).every((v) => v === false)).toBe(true);

    const delta2 = buildConditionDelta(makeInspection(), null);
    expect(Object.values(delta2).every((v) => v === false)).toBe(true);
  });

  it('returns all false when both sides are null', () => {
    const delta = buildConditionDelta(null, null);
    expect(Object.values(delta).every((v) => v === false)).toBe(true);
  });
});

describe('buildChecklistVariance', () => {
  it('reads legacy checklist payloads when checklist_items is absent', () => {
    const pickup = makeInspection({
      data: {
        ...makeInspection().data,
        evidence: {
          photo_paths: [],
          checklist: [{ key: 'engine_oil', label: 'Engine oil level within range', status: 'pass', note: null }],
        },
      },
    });
    const ret = makeReturnInspection({
      data: {
        ...makeReturnInspection().data,
        evidence: {
          photo_paths: [],
          checklist: [{ key: 'engine_oil', label: 'Engine oil level within range', status: 'fail', note: 'Low level' }],
        },
      },
    });

    expect(buildChecklistVariance(pickup, ret)).toEqual([
      {
        item: 'Engine oil level within range',
        pickupStatus: 'pass',
        returnStatus: 'fail',
        changed: true,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// InspectionComparisonScreen — rendering tests
// ---------------------------------------------------------------------------
describe('InspectionComparisonScreen', () => {
  function buildQueryChain(rows: unknown[]) {
    const result = { data: rows, error: null };
    const chain: Record<string, unknown> = {};

    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.then = (resolve: (v: typeof result) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);

    return chain;
  }

  it('renders heading and load form without loading inspections when no IDs provided', () => {
    render(<InspectionComparisonScreen />);
    expect(screen.getByText('Inspection Comparison')).toBeInTheDocument();
    expect(screen.getByLabelText('Contract Line ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Asset ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load Inspections' })).toBeInTheDocument();
  });

  it('shows an error when search is submitted without any identifiers', async () => {
    render(<InspectionComparisonScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Load Inspections' }));
    await waitFor(() => {
      expect(
        screen.getByText('Enter a Contract Line ID or Asset ID to load inspections.'),
      ).toBeInTheDocument();
    });
  });

  it('shows "no inspections" message when database returns empty results', async () => {
    fromMock.mockImplementation(() => buildQueryChain([]));
    render(<InspectionComparisonScreen initialContractLineId="line-missing" />);
    await waitFor(() => {
      expect(
        screen.getByText('No inspections found for the provided identifier.'),
      ).toBeInTheDocument();
    });
  });

  it('renders side-by-side comparison panels when checkout and return inspections are found', async () => {
    const checkoutEntity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-1',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'checkout',
            outcome: 'pass',
            resulting_asset_status: 'on_rent',
            inspected_at: '2026-06-01T09:00:00.000Z',
            notes: 'Internal checkout note',
            evidence: {
              signature_confirmed: true,
              photo_paths: ['a.jpg', 'b.jpg'],
              meter_reading: 1000,
              meter_unit: 'hrs',
              fuel_level_pct: 90,
            },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };

    const returnEntity = {
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      created_at: '2026-06-10T15:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-2',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'return',
            outcome: 'fail',
            resulting_asset_status: 'on_inspection_hold',
            inspected_at: '2026-06-10T15:00:00.000Z',
            notes: 'Internal return note',
            evidence: {
              signature_confirmed: true,
              photo_paths: ['c.jpg'],
              meter_reading: 1450,
              meter_unit: 'hrs',
              fuel_level_pct: 20,
            },
          },
          is_current: true,
          created_at: '2026-06-10T15:00:00.000Z',
        },
      ],
    };

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByText('Pickup / Checkout')).toBeInTheDocument();
      expect(screen.getByText('Return')).toBeInTheDocument();
    });

    // Outcomes should render
    expect(screen.getByText('Pass')).toBeInTheDocument();
    expect(screen.getByText('Fail')).toBeInTheDocument();

    // Delta summary section
    expect(screen.getByText('Condition Delta Summary')).toBeInTheDocument();
  });

  it('renders "Changed" delta badge when outcome differs between pickup and return', async () => {
    const checkoutEntity = {
      id: 'aaa',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: { inspection_type: 'checkout', outcome: 'pass', evidence: {} },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    const returnEntity = {
      id: 'bbb',
      created_at: '2026-06-10T15:00:00.000Z',
      entity_versions: [
        {
          id: 'v2',
          data: { inspection_type: 'return', outcome: 'fail', evidence: {} },
          is_current: true,
          created_at: '2026-06-10T15:00:00.000Z',
        },
      ],
    };

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByText('Pickup / Checkout')).toBeInTheDocument();
    });

    const changedBadges = screen.getAllByText('Changed');
    expect(changedBadges.length).toBeGreaterThan(0);
  });

  it('renders "Same" delta badges when conditions are identical', async () => {
    const sharedEvidence = {
      signature_confirmed: true,
      photo_paths: ['a.jpg'],
      meter_reading: 500,
      fuel_level_pct: 70,
    };
    const checkoutEntity = {
      id: 'aaa',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: { inspection_type: 'checkout', outcome: 'pass', evidence: sharedEvidence },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    const returnEntity = {
      id: 'bbb',
      created_at: '2026-06-10T15:00:00.000Z',
      entity_versions: [
        {
          id: 'v2',
          data: { inspection_type: 'return', outcome: 'pass', evidence: sharedEvidence },
          is_current: true,
          created_at: '2026-06-10T15:00:00.000Z',
        },
      ],
    };

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByText('Pickup / Checkout')).toBeInTheDocument();
    });

    const sameBadges = screen.getAllByText('Same');
    expect(sameBadges.length).toBeGreaterThan(0);
  });

  it('renders "Share Customer Recap" button when inspections are loaded', async () => {
    const entity = {
      id: 'aaa',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: { inspection_type: 'checkout', outcome: 'pass', evidence: {} },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    fromMock.mockImplementation(() => buildQueryChain([entity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Share customer recap' })).toBeInTheDocument();
    });
  });

  it('blocks rent-ready approval until deficiencies are resolved and required inspections are signed off', async () => {
    localStorage.clear();

    const checkoutEntity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-1',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'checkout',
            outcome: 'pass',
            resulting_asset_status: 'on_rent',
            evidence: {
              photo_paths: ['checkout-a.jpg'],
              checklist_items: [{ item: 'Tyres', status: 'pass' }],
            },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    const returnEntity = {
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      created_at: '2026-06-10T15:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-2',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'return',
            outcome: 'fail',
            resulting_asset_status: 'on_inspection_hold',
            evidence: {
              photo_paths: ['return-a.jpg'],
              checklist_items: [
                { item: 'Tyres', status: 'fail' },
                { item: 'Lights', status: 'pass' },
              ],
            },
          },
          is_current: true,
          created_at: '2026-06-10T15:00:00.000Z',
        },
      ],
    };

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    // Wait for the bundle to reflect the fully-loaded return inspection, which
    // populates deficiencies from the failed checklist items.  The bundle is
    // initialised twice: once eagerly (before the async fetch resolves, with
    // empty deficiencies) and again after the inspections load.  Both waits
    // must be satisfied together to avoid asserting against the premature state.
    await waitFor(() => {
      expect(screen.getByText('Inspection Evidence Bundle')).toBeInTheDocument();
      expect(screen.getByText('Open deficiencies remain unresolved.')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Mark rent-ready' })).toBeDisabled();
    expect(screen.getByText('Required inspection sign-off is still pending.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Reviewer name'), 'Alex Tech');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm required inspections passed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mark rent-ready' })).toBeEnabled();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Mark rent-ready' }));

    await waitFor(() => {
      expect(screen.getByText('Rent-ready approved')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/rent-?ready approved/i).length).toBeGreaterThan(0);
  });

  it('persists the evidence bundle review across remounts', async () => {
    localStorage.clear();

    const checkoutEntity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-1',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: {
              checklist_items: [{ item: 'Tyres', status: 'pass' }],
            },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    const returnEntity = {
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      created_at: '2026-06-10T15:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-2',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'return',
            outcome: 'pass',
            resulting_asset_status: 'available',
            evidence: {
              checklist_items: [{ item: 'Tyres', status: 'pass' }],
            },
          },
          is_current: true,
          created_at: '2026-06-10T15:00:00.000Z',
        },
      ],
    };

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    const { unmount } = render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByText('Inspection Evidence Bundle')).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Reviewer name'), 'Jordan Reviewer');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm required inspections passed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark rent-ready' }));

    await waitFor(() => {
      expect(screen.getByText('Rent-ready approved')).toBeInTheDocument();
    });

    unmount();

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Jordan Reviewer')).toBeInTheDocument();
    });
    expect(screen.getByText('Rent-ready approved')).toBeInTheDocument();
  });

  it('reuses the same persisted review state across queue and work-order entry paths', async () => {
    localStorage.clear();

    const checkoutEntity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-1',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: {
              checklist_items: [{ item: 'Tyres', status: 'pass' }],
            },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    const returnEntity = {
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      created_at: '2026-06-10T15:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-2',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'return',
            outcome: 'pass',
            resulting_asset_status: 'available',
            evidence: {
              checklist_items: [{ item: 'Tyres', status: 'pass' }],
            },
          },
          is_current: true,
          created_at: '2026-06-10T15:00:00.000Z',
        },
      ],
    };

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    const { unmount } = render(
      <InspectionComparisonScreen initialContractLineId="line-1" initialAssetId="asset-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Inspection Evidence Bundle')).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText('Reviewer name'), 'Jordan Reviewer');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm required inspections passed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark rent-ready' }));

    await waitFor(() => {
      expect(screen.getByText('Rent-ready approved')).toBeInTheDocument();
    });

    unmount();

    render(<InspectionComparisonScreen initialAssetId="asset-1" initialWorkOrderId="wo-7" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Jordan Reviewer')).toBeInTheDocument();
    });
    expect(screen.getByText('Rent-ready approved')).toBeInTheDocument();
    expect(screen.getByText('Work order: wo-7')).toBeInTheDocument();
  });

  it('keeps the linked work order when reopening the same bundle from the queue path', async () => {
    localStorage.clear();

    const checkoutEntity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-1',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: {
              checklist_items: [{ item: 'Tyres', status: 'pass' }],
            },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    const returnEntity = {
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      created_at: '2026-06-10T15:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-2',
          data: {
            asset_id: 'asset-1',
            contract_line_id: 'line-1',
            inspection_type: 'return',
            outcome: 'pass',
            resulting_asset_status: 'available',
            evidence: {
              checklist_items: [{ item: 'Tyres', status: 'pass' }],
            },
          },
          is_current: true,
          created_at: '2026-06-10T15:00:00.000Z',
        },
      ],
    };

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    const { unmount } = render(
      <InspectionComparisonScreen initialContractLineId="line-1" initialAssetId="asset-1" initialWorkOrderId="wo-7" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Inspection Evidence Bundle')).toBeInTheDocument();
    });
    expect(screen.getByText('Work order: wo-7')).toBeInTheDocument();

    unmount();

    render(<InspectionComparisonScreen initialContractLineId="line-1" initialAssetId="asset-1" />);

    await waitFor(() => {
      expect(screen.getByText('Inspection Evidence Bundle')).toBeInTheDocument();
    });
    expect(screen.getByText('Work order: wo-7')).toBeInTheDocument();
  });

  it('copies a customer-safe recap and opens the recap modal when "Share Customer Recap" is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const entity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: {
            inspection_type: 'checkout',
            outcome: 'pass',
            resulting_asset_status: 'on_rent',
            inspected_at: '2026-06-01T09:00:00.000Z',
            notes: 'PRIVATE INTERNAL CHECKOUT NOTE',
            evidence: {
              notes: 'PRIVATE INTERNAL EVIDENCE NOTE',
              signature_confirmed: true,
              photo_paths: [],
            },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    fromMock.mockImplementation(() => buildQueryChain([entity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Share customer recap' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Share customer recap' }));

    await waitFor(() => {
      expect(screen.getByText('Customer Recap')).toBeInTheDocument();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('Customer Inspection Recap');
    expect(writeText.mock.calls[0]?.[0]).toContain(
      'Audit ref: aaaaaaaa-0000-4000-8000-000000000001',
    );
    expect(writeText.mock.calls[0]?.[0]).not.toContain('PRIVATE INTERNAL CHECKOUT NOTE');
    expect(writeText.mock.calls[0]?.[0]).not.toContain('PRIVATE INTERNAL EVIDENCE NOTE');

    // Recap should include audit ref info
    expect(screen.getByText(/Audit references are stable identifiers tied to the original inspection records/)).toBeInTheDocument();
    expect(screen.getByLabelText('Copy audit references')).toBeInTheDocument();
  });

  it('recap modal does NOT display internal inspection notes', async () => {
    const entity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: {
            inspection_type: 'checkout',
            outcome: 'pass',
            resulting_asset_status: 'on_rent',
            inspected_at: '2026-06-01T09:00:00.000Z',
            notes: 'TOP SECRET INTERNAL NOTE',
            evidence: {
              notes: 'TOP SECRET EVIDENCE NOTE',
              signature_confirmed: true,
              photo_paths: [],
            },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    fromMock.mockImplementation(() => buildQueryChain([entity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Share customer recap' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Share customer recap' }));

    await waitFor(() => {
      expect(screen.getByText('Customer Recap')).toBeInTheDocument();
    });

    expect(screen.queryByText('TOP SECRET INTERNAL NOTE')).not.toBeInTheDocument();
    expect(screen.queryByText('TOP SECRET EVIDENCE NOTE')).not.toBeInTheDocument();
  });

  it('recap modal shows entity IDs as stable audit references', async () => {
    const entity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000099',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: {
            inspection_type: 'checkout',
            outcome: 'pass',
            resulting_asset_status: 'on_rent',
            inspected_at: '2026-06-01T09:00:00.000Z',
            evidence: { signature_confirmed: true, photo_paths: [] },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    fromMock.mockImplementation(() => buildQueryChain([entity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Share customer recap' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Share customer recap' }));

    await waitFor(() => {
      expect(screen.getByText('Customer Recap')).toBeInTheDocument();
    });

    // Entity ID appears in the recap detail row and the audit reference code block — both are correct
    const auditRefs = screen.getAllByText('aaaaaaaa-0000-4000-8000-000000000099');
    expect(auditRefs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildChecklistVariance — checklist comparison tests
// ---------------------------------------------------------------------------
describe('buildChecklistVariance', () => {
  it('returns empty array when both inspections are null', () => {
    expect(buildChecklistVariance(null, null)).toEqual([]);
  });

  it('returns items from pickup when return is null (all changed)', () => {
    const pickup = makeInspection();
    const variance = buildChecklistVariance(pickup, null);
    expect(variance.length).toBe(3);
    variance.forEach((v) => {
      expect(v.returnStatus).toBeNull();
      expect(v.changed).toBe(true);
    });
  });

  it('returns items from return when pickup is null (all changed)', () => {
    const ret = makeReturnInspection();
    const variance = buildChecklistVariance(null, ret);
    expect(variance.length).toBe(3);
    variance.forEach((v) => {
      expect(v.pickupStatus).toBeNull();
      expect(v.changed).toBe(true);
    });
  });

  it('flags items with different statuses as changed', () => {
    const pickup = makeInspection();
    const ret = makeReturnInspection();
    const variance = buildChecklistVariance(pickup, ret);

    const tyres = variance.find((v) => v.item === 'Tyres');
    expect(tyres).toBeDefined();
    expect(tyres?.pickupStatus).toBe('pass');
    expect(tyres?.returnStatus).toBe('fail');
    expect(tyres?.changed).toBe(true);
  });

  it('does NOT flag items with identical statuses as changed', () => {
    const pickup = makeInspection();
    const ret = makeReturnInspection();
    const variance = buildChecklistVariance(pickup, ret);

    const lights = variance.find((v) => v.item === 'Lights');
    expect(lights).toBeDefined();
    expect(lights?.pickupStatus).toBe('pass');
    expect(lights?.returnStatus).toBe('pass');
    expect(lights?.changed).toBe(false);
  });

  it('flags items as changed when status goes from na to fail', () => {
    const pickup = makeInspection();
    const ret = makeReturnInspection();
    const variance = buildChecklistVariance(pickup, ret);

    const hydraulics = variance.find((v) => v.item === 'Hydraulics');
    expect(hydraulics).toBeDefined();
    expect(hydraulics?.pickupStatus).toBe('na');
    expect(hydraulics?.returnStatus).toBe('fail');
    expect(hydraulics?.changed).toBe(true);
  });

  it('includes items only present on one side as changed', () => {
    const pickup = makeInspection();
    if (pickup.data.evidence) {
      pickup.data.evidence.checklist_items = [
        { item: 'Tyres', status: 'pass' },
        { item: 'Extra Item', status: 'pass' },
      ];
    }
    const ret = makeReturnInspection();
    if (ret.data.evidence) {
      ret.data.evidence.checklist_items = [{ item: 'Tyres', status: 'fail' }];
    }
    const variance = buildChecklistVariance(pickup, ret);

    const extra = variance.find((v) => v.item === 'Extra Item');
    expect(extra).toBeDefined();
    expect(extra?.pickupStatus).toBe('pass');
    expect(extra?.returnStatus).toBeNull();
    expect(extra?.changed).toBe(true);
  });

  it('returns all unchanged when both sides have identical checklist items', () => {
    const pickup = makeInspection();
    const ret = makeInspection({
      entityId: 'bbbbbbbb-0000-4000-8000-000000000002',
      data: { ...makeInspection().data, inspection_type: 'return' },
    });
    const variance = buildChecklistVariance(pickup, ret);
    expect(variance.every((v) => !v.changed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Media gallery rendering tests
// ---------------------------------------------------------------------------
describe('InspectionComparisonScreen — media gallery', () => {
  function buildQueryChain(rows: unknown[]) {
    const result = { data: rows, error: null };
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.then = (resolve: (v: typeof result) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  }

  it('renders photo thumbnails for each photo path in the evidence', async () => {
    const entity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: {
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: { photo_paths: ['line-1/photo-a.jpg', 'line-1/photo-b.jpg'] },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    fromMock.mockImplementation(() => buildQueryChain([entity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText('Evidence photo: line-1/photo-a.jpg')).toBeInTheDocument();
      expect(screen.getByLabelText('Evidence photo: line-1/photo-b.jpg')).toBeInTheDocument();
    });
  });

  it('shows "No photos recorded" when evidence has an empty photo_paths array', async () => {
    const entity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: {
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: { photo_paths: [] },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    fromMock.mockImplementation(() => buildQueryChain([entity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getAllByText('No photos recorded.').length).toBeGreaterThan(0);
    });
  });

  it('photo thumbnails use Supabase storage public URLs', async () => {
    const entity = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-06-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'v1',
          data: {
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: { photo_paths: ['line-1/photo-a.jpg'] },
          },
          is_current: true,
          created_at: '2026-06-01T09:00:00.000Z',
        },
      ],
    };
    fromMock.mockImplementation(() => buildQueryChain([entity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      const img = screen.getByLabelText('Evidence photo: line-1/photo-a.jpg') as HTMLImageElement;
      expect(img.src).toBe('https://storage.mock/field-evidence/line-1/photo-a.jpg');
    });
  });
});

// ---------------------------------------------------------------------------
// Checklist variance rendering tests
// ---------------------------------------------------------------------------
describe('InspectionComparisonScreen — checklist variance', () => {
  function buildQueryChain(rows: unknown[]) {
    const result = { data: rows, error: null };
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.then = (resolve: (v: typeof result) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  }

  function makeEntity(id: string, data: object, createdAt = '2026-06-01T09:00:00.000Z') {
    return {
      id,
      created_at: createdAt,
      entity_versions: [
        { id: `ver-${id}`, data, is_current: true, created_at: createdAt },
      ],
    };
  }

  it('renders the Checklist Variance card when both inspections have checklist items', async () => {
    const checkoutEntity = makeEntity('aaa-checkout', {
      inspection_type: 'checkout',
      outcome: 'pass',
      evidence: {
        photo_paths: [],
        checklist_items: [
          { item: 'Tyres', status: 'pass' },
          { item: 'Lights', status: 'pass' },
        ],
      },
    });
    const returnEntity = makeEntity('bbb-return', {
      inspection_type: 'return',
      outcome: 'fail',
      evidence: {
        photo_paths: [],
        checklist_items: [
          { item: 'Tyres', status: 'fail' },
          { item: 'Lights', status: 'pass' },
        ],
      },
    }, '2026-06-10T15:00:00.000Z');

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByText('Checklist Variance')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Checklist item: Tyres')).toBeInTheDocument();
    expect(screen.getByLabelText('Checklist item: Lights')).toBeInTheDocument();
  });

  it('renders "Changed" badge for checklist items with differing statuses', async () => {
    const checkoutEntity = makeEntity('aaa-checkout', {
      inspection_type: 'checkout',
      outcome: 'pass',
      evidence: {
        photo_paths: [],
        checklist_items: [{ item: 'Tyres', status: 'pass' }],
      },
    });
    const returnEntity = makeEntity('bbb-return', {
      inspection_type: 'return',
      outcome: 'fail',
      evidence: {
        photo_paths: [],
        checklist_items: [{ item: 'Tyres', status: 'fail' }],
      },
    }, '2026-06-10T15:00:00.000Z');

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByText('Checklist Variance')).toBeInTheDocument();
    });

    // 'Changed' badge should appear in the checklist variance section for the Tyres item
    const tyresRow = screen.getByLabelText('Checklist item: Tyres');
    expect(tyresRow.textContent).toContain('Changed');
  });

  it('does NOT render "Changed" badge for checklist items with identical statuses', async () => {
    const checkoutEntity = makeEntity('aaa-checkout', {
      inspection_type: 'checkout',
      outcome: 'pass',
      evidence: {
        photo_paths: [],
        checklist_items: [{ item: 'Lights', status: 'pass' }],
      },
    });
    const returnEntity = makeEntity('bbb-return', {
      inspection_type: 'return',
      outcome: 'pass',
      evidence: {
        photo_paths: [],
        checklist_items: [{ item: 'Lights', status: 'pass' }],
      },
    }, '2026-06-10T15:00:00.000Z');

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByText('Checklist Variance')).toBeInTheDocument();
    });

    const lightsRow = screen.getByLabelText('Checklist item: Lights');
    expect(lightsRow.textContent).not.toContain('Changed');
  });

  it('does not render Checklist Variance card when no checklist items are present', async () => {
    const checkoutEntity = makeEntity('aaa-checkout', {
      inspection_type: 'checkout',
      outcome: 'pass',
      evidence: { photo_paths: [] },
    });
    const returnEntity = makeEntity('bbb-return', {
      inspection_type: 'return',
      outcome: 'fail',
      evidence: { photo_paths: [] },
    }, '2026-06-10T15:00:00.000Z');

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity, returnEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getByText('Pickup / Checkout')).toBeInTheDocument();
    });

    expect(screen.queryByText('Checklist Variance')).not.toBeInTheDocument();
  });

  it('renders checklist items per-column in each inspection panel', async () => {
    const checkoutEntity = makeEntity('aaa-checkout', {
      inspection_type: 'checkout',
      outcome: 'pass',
      evidence: {
        photo_paths: [],
        checklist_items: [{ item: 'Hydraulics', status: 'pass' }],
      },
    });

    fromMock.mockImplementation(() => buildQueryChain([checkoutEntity]));

    render(<InspectionComparisonScreen initialContractLineId="line-1" />);

    await waitFor(() => {
      expect(screen.getAllByText('Checklist').length).toBeGreaterThan(0);
      // Hydraulics appears in both the per-column section and the checklist variance card
      expect(screen.getAllByText('Hydraulics').length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Asset-ID multi-cycle pairing regression
// Verifies that when an asset has inspections from multiple rental cycles
// (different contract_line_ids) the UI pairs checkout and return from the
// same event rather than mixing records across different contract lines.
// ---------------------------------------------------------------------------
describe('InspectionComparisonScreen — asset-ID multi-cycle pairing', () => {
  function buildQueryChain(rows: unknown[]) {
    const result = { data: rows, error: null };
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.then = (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  }

  it('pairs checkout and return from the same contract line when the asset has multiple rental cycles', async () => {
    // Scenario: asset "asset-multi" has been rented twice.
    //   Cycle 1 (line-old): checkout only — return was never recorded.
    //   Cycle 2 (line-new): checkout + return — the complete, coherent pair.
    //
    // Without the grouping fix the old code would pair line-old's checkout with
    // line-new's return (first checkout + first return in the full result set).
    // With the fix the complete pair from line-new must be selected.

    // Ordered oldest→newest (ascending created_at, matching the query order).
    const oldCheckout = {
      id: 'aa000000-0000-4000-8000-000000000001',
      created_at: '2024-01-10T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-aa',
          data: {
            asset_id: 'asset-multi',
            contract_line_id: 'line-old',
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: { photo_paths: [] },
          },
          is_current: true,
          created_at: '2024-01-10T09:00:00.000Z',
        },
      ],
    };
    const newCheckout = {
      id: 'bb000000-0000-4000-8000-000000000002',
      created_at: '2026-03-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-bb',
          data: {
            asset_id: 'asset-multi',
            contract_line_id: 'line-new',
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: { photo_paths: [] },
          },
          is_current: true,
          created_at: '2026-03-01T09:00:00.000Z',
        },
      ],
    };
    const newReturn = {
      id: 'cc000000-0000-4000-8000-000000000003',
      created_at: '2026-03-15T14:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-cc',
          data: {
            asset_id: 'asset-multi',
            contract_line_id: 'line-new',
            inspection_type: 'return',
            outcome: 'fail',
            evidence: { photo_paths: [] },
          },
          is_current: true,
          created_at: '2026-03-15T14:00:00.000Z',
        },
      ],
    };

    // Return all three records as the asset-ID query would.
    fromMock.mockImplementation(() => buildQueryChain([oldCheckout, newCheckout, newReturn]));

    render(<InspectionComparisonScreen initialAssetId="asset-multi" />);

    await waitFor(() => {
      expect(screen.getByText('Pickup / Checkout')).toBeInTheDocument();
      expect(screen.getByText('Return')).toBeInTheDocument();
    });

    // line-new's checkout entity badge should be visible (bb000000).
    // line-old's checkout entity badge (aa000000) must NOT appear — that would
    // indicate the old buggy cross-event pairing.
    expect(screen.getByText(/^bb000000/)).toBeInTheDocument();
    expect(screen.queryByText(/^aa000000/)).not.toBeInTheDocument();

    // The return column should show line-new's return (cc000000).
    expect(screen.getByText(/^cc000000/)).toBeInTheDocument();
  });

  it('falls back to the most recent group when no group has a complete pair', async () => {
    // Only a checkout exists for line-new; line-old also only has a checkout.
    // Expected: line-new's checkout is shown as pickup (most recent group).
    const oldCheckout = {
      id: 'aa000000-0000-4000-8000-000000000001',
      created_at: '2024-01-10T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-aa',
          data: {
            asset_id: 'asset-multi',
            contract_line_id: 'line-old',
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: { photo_paths: [] },
          },
          is_current: true,
          created_at: '2024-01-10T09:00:00.000Z',
        },
      ],
    };
    const newCheckout = {
      id: 'bb000000-0000-4000-8000-000000000002',
      created_at: '2026-03-01T09:00:00.000Z',
      entity_versions: [
        {
          id: 'ver-bb',
          data: {
            asset_id: 'asset-multi',
            contract_line_id: 'line-new',
            inspection_type: 'checkout',
            outcome: 'pass',
            evidence: { photo_paths: [] },
          },
          is_current: true,
          created_at: '2026-03-01T09:00:00.000Z',
        },
      ],
    };

    fromMock.mockImplementation(() => buildQueryChain([oldCheckout, newCheckout]));

    render(<InspectionComparisonScreen initialAssetId="asset-multi" />);

    await waitFor(() => {
      expect(screen.getByText('Pickup / Checkout')).toBeInTheDocument();
    });

    // The most recent group (line-new) should supply the pickup column.
    expect(screen.getByText(/^bb000000/)).toBeInTheDocument();
    expect(screen.queryByText(/^aa000000/)).not.toBeInTheDocument();
  });
});
