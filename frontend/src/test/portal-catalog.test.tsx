import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
  };
});

import {
  PortalCatalogScreen,
  formatRate,
  type CatalogAsset,
} from '@/routes/portal/catalog/$jobSiteId';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JOB_SITE_ID = 'site-abc-123';

const ASSET_1: CatalogAsset = {
  assetId: 'asset-001',
  name: 'CAT 320 Excavator',
  make: 'Caterpillar',
  model: '320',
  year: '2021',
  identifier: 'EX-001',
  categoryId: 'cat-earthmoving',
  branchId: 'branch-north',
  dailyRate: '800',
  weeklyRate: '4200',
  monthlyRate: '14000',
  imageUrl: '/equipment-images/earthmoving.svg',
  status: 'available',
  fuelType: 'diesel',
  meterType: 'hours',
  condition: 'excellent',
  tags: ['earthmoving', 'tracked'],
  specs: { bucket: '1.2m3' },
  inventoryKind: 'serialized',
  inventoryEntityType: 'asset',
};

const ASSET_2: CatalogAsset = {
  assetId: 'asset-002',
  name: 'JLG 600S Boom Lift',
  make: 'JLG',
  model: '600S',
  year: '2022',
  identifier: 'BL-001',
  categoryId: 'cat-lifts',
  branchId: 'branch-south',
  dailyRate: '350',
  weeklyRate: '1800',
  monthlyRate: '6000',
  imageUrl: null,
  status: 'available',
  fuelType: 'diesel',
  meterType: 'hours',
  condition: 'good',
  tags: ['lift'],
  specs: null,
  inventoryKind: 'serialized',
  inventoryEntityType: 'asset',
};

function catalogRows() {
  return [
    {
      asset_id: ASSET_1.assetId,
      name: ASSET_1.name,
      make: ASSET_1.make,
      model: ASSET_1.model,
      year: ASSET_1.year,
      identifier: ASSET_1.identifier,
      category_id: ASSET_1.categoryId,
      branch_id: ASSET_1.branchId,
      daily_rate: ASSET_1.dailyRate,
      weekly_rate: ASSET_1.weeklyRate,
      monthly_rate: ASSET_1.monthlyRate,
      image_url: ASSET_1.imageUrl,
      status: ASSET_1.status,
      fuel_type: ASSET_1.fuelType,
      meter_type: ASSET_1.meterType,
      condition: ASSET_1.condition,
      tags: ASSET_1.tags,
      specs: ASSET_1.specs,
      inventory_kind: ASSET_1.inventoryKind,
      inventory_entity_type: ASSET_1.inventoryEntityType,
    },
    {
      asset_id: ASSET_2.assetId,
      name: ASSET_2.name,
      make: ASSET_2.make,
      model: ASSET_2.model,
      year: ASSET_2.year,
      identifier: ASSET_2.identifier,
      category_id: ASSET_2.categoryId,
      branch_id: ASSET_2.branchId,
      daily_rate: ASSET_2.dailyRate,
      weekly_rate: ASSET_2.weeklyRate,
      monthly_rate: ASSET_2.monthlyRate,
      image_url: ASSET_2.imageUrl,
      status: ASSET_2.status,
      fuel_type: ASSET_2.fuelType,
      meter_type: ASSET_2.meterType,
      condition: ASSET_2.condition,
      tags: ASSET_2.tags,
      specs: ASSET_2.specs,
      inventory_kind: ASSET_2.inventoryKind,
      inventory_entity_type: ASSET_2.inventoryEntityType,
    },
  ];
}

function mockCatalogLoad(rows = catalogRows()) {
  rpcMock.mockImplementation((fnName: string) => {
    if (fnName === 'portal_get_catalog_assets') {
      return Promise.resolve({ data: rows, error: null });
    }
    return Promise.resolve({ data: [{ requisition_id: 'req-001' }], error: null });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PortalCatalogScreen', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    // Default: catalog loads successfully, submit returns a requisition ID.
    // Individual tests override via mockCatalogLoad() or rpcMock.mockImplementation().
    rpcMock.mockImplementation((fnName: string) => {
      if (fnName === 'portal_get_catalog_assets') {
        return Promise.resolve({ data: catalogRows(), error: null });
      }
      return Promise.resolve({ data: [{ requisition_id: 'req-001' }], error: null });
    });
  });

  it('renders the portal catalog page container', async () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('portal-catalog-page')).toBeInTheDocument();
    });
  });

  it('shows a loading indicator while catalog is being fetched', () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
  });

  it('shows the job site id in the header', async () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('site-id-label')).toHaveTextContent(JOB_SITE_ID);
    });
  });

  it('renders asset cards for all catalog assets', async () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument();
      expect(screen.getByTestId('catalog-asset-asset-002')).toBeInTheDocument();
    });
  });

  it('shows asset names in catalog cards', async () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByText('CAT 320 Excavator')).toBeInTheDocument();
      expect(screen.getByText('JLG 600S Boom Lift')).toBeInTheDocument();
    });
  });

  it('shows daily rate on asset card', async () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getAllByText(/\$800/)[0]).toBeInTheDocument();
    });
  });

  it('shows search input after loading', async () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('catalog-search-input')).toBeInTheDocument();
    });
  });

  it('shows category filter buttons when multiple categories present', async () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('category-filters')).toBeInTheDocument();
      expect(screen.getByTestId('category-all')).toBeInTheDocument();
      expect(screen.getByTestId('category-cat-earthmoving')).toBeInTheDocument();
      expect(screen.getByTestId('category-cat-lifts')).toBeInTheDocument();
    });
  });

  it('filters assets by search text', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => expect(screen.getByTestId('catalog-search-input')).toBeInTheDocument());

    await user.type(screen.getByTestId('catalog-search-input'), 'boom');

    expect(screen.queryByTestId('catalog-asset-asset-001')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-asset-asset-002')).toBeInTheDocument();
  });

  it('filters assets by attribute tags in search text', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => expect(screen.getByTestId('catalog-search-input')).toBeInTheDocument());

    await user.type(screen.getByTestId('catalog-search-input'), 'tracked');

    expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-asset-asset-002')).not.toBeInTheDocument();
  });

  it('filters assets by category', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => expect(screen.getByTestId('category-cat-earthmoving')).toBeInTheDocument());

    await user.click(screen.getByTestId('category-cat-earthmoving'));

    expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-asset-asset-002')).not.toBeInTheDocument();
  });

  it('restores all assets when All Equipment is clicked', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => expect(screen.getByTestId('category-cat-earthmoving')).toBeInTheDocument());

    await user.click(screen.getByTestId('category-cat-earthmoving'));
    await user.click(screen.getByTestId('category-all'));

    expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-asset-asset-002')).toBeInTheDocument();
  });

  it('shows empty state when no assets match search', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => expect(screen.getByTestId('catalog-search-input')).toBeInTheDocument());

    await user.type(screen.getByTestId('catalog-search-input'), 'xyznotexist');

    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByTestId('clear-filters-button')).toBeInTheDocument();
  });

  it('shows empty state when catalog is empty', async () => {
    mockCatalogLoad([]);
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
  });

  it('shows a load error alert when the catalog fetch fails', async () => {
    rpcMock.mockImplementation((fnName: string) => {
      if (fnName === 'portal_get_catalog_assets') {
        return Promise.resolve({ data: null, error: { message: 'DB connection failed' } });
      }
      return Promise.resolve({ data: [{ requisition_id: 'req-001' }], error: null });
    });

    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('load-error')).toBeInTheDocument();
      expect(screen.getByText('DB connection failed')).toBeInTheDocument();
    });
  });

  it('opens the requisition form when an asset card is clicked', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument());

    await user.click(screen.getByTestId('catalog-asset-asset-001'));

    expect(screen.getByTestId('requisition-form')).toBeInTheDocument();
    expect(screen.getByTestId('req-start-date')).toBeInTheDocument();
    expect(screen.getByTestId('req-end-date')).toBeInTheDocument();
    expect(screen.getByTestId('req-dispatch-yard')).toBeInTheDocument();
    expect(screen.getByTestId('req-notes')).toBeInTheDocument();
    expect(screen.getByTestId('req-submit-button')).toBeInTheDocument();
  });

  it('submits a requisition and shows success message', async () => {
    const user = userEvent.setup();
    const todayIso = new Date().toISOString().slice(0, 10);
    mockCatalogLoad();
    render(
      <PortalCatalogScreen
        jobSiteId={JOB_SITE_ID}
        pageUrl={`http://example.com/portal/catalog/${JOB_SITE_ID}?scope=site-scope-token`}
      />
    );

    await waitFor(() => expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument());
    await user.click(screen.getByTestId('catalog-asset-asset-001'));

    await waitFor(() => expect(screen.getByTestId('req-submit-button')).toBeInTheDocument());

    await act(async () => {
      await user.click(screen.getByTestId('req-submit-button'));
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('portal_submit_requisition', expect.objectContaining({
        p_job_site_id: JOB_SITE_ID,
        p_asset_id: ASSET_1.assetId,
        p_scope_token: 'site-scope-token',
      }));
      const successEl = screen.getByTestId('requisition-success');
      expect(successEl).toBeInTheDocument();
      // Must expose the requisition ID so dispatch can reference it.
      expect(successEl).toHaveTextContent('req-001');
      // Must expose a dispatch-ready link.
      const dispatchLink = screen.getByTestId('dispatch-handoff-link');
      expect(dispatchLink).toBeInTheDocument();
      expect(dispatchLink).toHaveAttribute(
        'href',
        '/entities/requisition/req-001?source=portal_catalog&assetName=CAT+320+Excavator&jobSiteId=site-abc-123&startDate='
        + todayIso
        + '&endDate='
        + todayIso
      );
    });
  });

  it('passes dispatch yard and notes when filled in', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(
      <PortalCatalogScreen
        jobSiteId={JOB_SITE_ID}
        pageUrl={`http://example.com/portal/catalog/${JOB_SITE_ID}?scope=site-scope-token`}
      />
    );

    await waitFor(() => expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument());
    await user.click(screen.getByTestId('catalog-asset-asset-001'));

    await waitFor(() => expect(screen.getByTestId('req-dispatch-yard')).toBeInTheDocument());
    await user.type(screen.getByTestId('req-dispatch-yard'), 'North Yard');
    await user.type(screen.getByTestId('req-notes'), 'Deliver to gate 3');

    await act(async () => {
      await user.click(screen.getByTestId('req-submit-button'));
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('portal_submit_requisition', expect.objectContaining({
        p_dispatch_yard: 'North Yard',
        p_notes: 'Deliver to gate 3',
      }));
    });
  });

  it('rejects requisition submission when scope token is missing', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    // No ?scope= in URL
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} pageUrl={`http://example.com/portal/catalog/${JOB_SITE_ID}`} />);

    await waitFor(() => expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument());
    await user.click(screen.getByTestId('catalog-asset-asset-001'));

    await waitFor(() => expect(screen.getByTestId('req-submit-button')).toBeInTheDocument());

    await act(async () => {
      await user.click(screen.getByTestId('req-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('requisition-error')).toBeInTheDocument();
      expect(screen.getByText(/Missing or invalid portal scope token/i)).toBeInTheDocument();
    });
    expect(rpcMock).not.toHaveBeenCalledWith('portal_submit_requisition', expect.anything());
  });

  it('shows an error alert when the requisition RPC fails', async () => {
    const user = userEvent.setup();
    rpcMock.mockImplementation((fnName: string) => {
      if (fnName === 'portal_get_catalog_assets') {
        return Promise.resolve({ data: catalogRows(), error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'rpc failed' } });
    });
    render(
      <PortalCatalogScreen
        jobSiteId={JOB_SITE_ID}
        pageUrl={`http://example.com/portal/catalog/${JOB_SITE_ID}?scope=site-scope-token`}
      />
    );

    await waitFor(() => expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument());
    await user.click(screen.getByTestId('catalog-asset-asset-001'));

    await waitFor(() => expect(screen.getByTestId('req-submit-button')).toBeInTheDocument());

    await act(async () => {
      await user.click(screen.getByTestId('req-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('requisition-error')).toBeInTheDocument();
      expect(screen.getByText('rpc failed')).toBeInTheDocument();
    });
  });

  it('clears requisition success when the page URL changes to a missing scope token', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    const { rerender } = render(
      <PortalCatalogScreen
        jobSiteId={JOB_SITE_ID}
        pageUrl={`http://example.com/portal/catalog/${JOB_SITE_ID}?scope=site-scope-token`}
      />
    );

    await waitFor(() => expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument());
    await user.click(screen.getByTestId('catalog-asset-asset-001'));
    await waitFor(() => expect(screen.getByTestId('req-submit-button')).toBeInTheDocument());
    await act(async () => {
      await user.click(screen.getByTestId('req-submit-button'));
    });
    await waitFor(() => expect(screen.getByTestId('requisition-success')).toBeInTheDocument());

    rpcMock.mockImplementation((fnName: string) => {
      if (fnName === 'portal_get_catalog_assets') {
        return Promise.resolve({ data: null, error: { message: 'Portal scope token is required' } });
      }
      return Promise.resolve({ data: [{ requisition_id: 'req-001' }], error: null });
    });

    rerender(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} pageUrl={`http://example.com/portal/catalog/${JOB_SITE_ID}`} />);

    await waitFor(() => expect(screen.getByTestId('load-error')).toBeInTheDocument());
    expect(screen.queryByTestId('requisition-success')).not.toBeInTheDocument();
  });

  it('closes the requisition form when cancel is clicked', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument());

    await user.click(screen.getByTestId('catalog-asset-asset-001'));
    await waitFor(() => expect(screen.getByTestId('requisition-form')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Close requisition form' }));

    expect(screen.queryByTestId('requisition-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-asset-asset-001')).toBeInTheDocument();
  });

  it('shows the asset grid after closing form without submitting', async () => {
    const user = userEvent.setup();
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => expect(screen.getByTestId('asset-grid')).toBeInTheDocument());

    await user.click(screen.getByTestId('catalog-asset-asset-001'));
    await waitFor(() => expect(screen.getByTestId('requisition-panel')).toBeInTheDocument());
    // Grid is hidden while form open
    expect(screen.queryByTestId('asset-grid')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close requisition form' }));
    await waitFor(() => expect(screen.getByTestId('asset-grid')).toBeInTheDocument());
  });

  it('shows asset count badge', async () => {
    mockCatalogLoad();
    render(<PortalCatalogScreen jobSiteId={JOB_SITE_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/2 of 2 available/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for pure helpers
// ---------------------------------------------------------------------------

describe('formatRate', () => {
  it('returns — for null', () => {
    expect(formatRate(null)).toBe('—');
  });

  it('returns — for non-numeric string', () => {
    expect(formatRate('not-a-number')).toBe('—');
  });

  it('formats an integer rate with $ prefix', () => {
    const result = formatRate('800');
    expect(result).toMatch(/^\$800/);
  });

  it('formats a decimal rate', () => {
    const result = formatRate('350.50');
    expect(result).toMatch(/\$350/);
  });
});
