import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext, evaluateExpression } from '@/engine/ExpressionEvaluator';
import entityListPage from './entity-list.json';
import entityDetailPage from './entity-detail.json';
import rentalAvailabilityPage from './rental-availability.json';
import type { SupabaseDataSource } from '@/engine/types';

function hasEntityVersions(value: unknown): value is { entity_versions: Array<{ version_number: number; is_current: boolean }> } {
  return (
    value !== null
    && typeof value === 'object'
    && Array.isArray((value as { entity_versions?: unknown }).entity_versions)
  );
}

describe('rental entity page definitions', () => {
  it('builds current-state entity queries from the route entity type', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      entityListPage.dataSources.entities as SupabaseDataSource,
      createExpressionContext({
        params: { entityType: 'customer' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith(
      'id, entity_type, source_record_id, created_at, entity_versions!inner(id, data, is_current, version_number)'
    );
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'customer');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('executes the detail query as a single-record fetch keyed by id', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { id: 'asset-1' },
      error: null,
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: singleMock,
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    const result = await executeSupabaseQuery(
      client as never,
      entityDetailPage.dataSources.entity as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'asset-1', entityType: 'asset' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith('*, entity_versions(*)');
    expect(query.eq).toHaveBeenCalledWith('id', 'asset-1');
    expect(query.order).toHaveBeenCalledWith('version_number', {
      ascending: false,
      referencedTable: 'entity_versions',
    });
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ id: 'asset-1' });
  });

  it('normalizes embedded entity_versions so current/latest appears first', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: {
        id: 'asset-1',
        entity_versions: [
          { id: 'v1', version_number: 1, is_current: false, data: { name: 'Old' } },
          { id: 'v3', version_number: 3, is_current: true, data: { name: 'Current' } },
          { id: 'v2', version_number: 2, is_current: false, data: { name: 'Older' } },
        ],
      },
      error: null,
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: singleMock,
    };
    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    const result = await executeSupabaseQuery(
      client as never,
      entityDetailPage.dataSources.entity as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'asset-1', entityType: 'asset' },
      })
    );

    if (!hasEntityVersions(result)) {
      throw new Error('Expected entity detail response with entity_versions');
    }

    expect(result.entity_versions.map((version) => version.version_number)).toEqual([3, 2, 1]);
    expect(result.entity_versions[0].is_current).toBe(true);
  });

  it('queries branch/category availability from the rental availability view', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      rentalAvailabilityPage.dataSources.availability as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('rental_asset_availability_current');
    expect(query.select).toHaveBeenCalledWith('*');
    expect(query.order).toHaveBeenNthCalledWith(1, 'branch_name', { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, 'asset_category_name', { ascending: true });
  });

  it('maintenanceDownState datasource is disabled for non-asset entity routes', () => {
    const source = entityDetailPage.dataSources.maintenanceDownState;
    expect(source).toBeDefined();
    expect(source.enabled).toBeDefined();

    // Should be enabled only for asset routes
    const assetCtx = createExpressionContext({ params: { entityType: 'asset', id: 'a1' } });
    expect(Boolean(evaluateExpression(source.enabled as string, assetCtx))).toBe(true);

    // Must be disabled for non-asset routes so .single() is never called
    for (const entityType of ['customer', 'branch', 'contact', 'invoice', 'job_site', 'asset_category']) {
      const ctx = createExpressionContext({ params: { entityType, id: 'x1' } });
      expect(Boolean(evaluateExpression(source.enabled as string, ctx))).toBe(false);
    }
  });

  it('assetAnalytics datasource queries v_asset_analytics_current for asset routes only', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      entityDetailPage.dataSources.assetAnalytics as SupabaseDataSource,
      createExpressionContext({
        params: { entityType: 'asset', id: 'asset-1' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('v_asset_analytics_current');
    expect(query.select).toHaveBeenCalledWith(
      'asset_id, asset_name, asset_category_id, asset_category_name, branch_id, branch_name, ownership_type, cost_basis, lifetime_revenue, utilization_pct, downtime_pct, total_downtime_minutes, rental_frequency, roi_pct, roi_status, last_order_at, calendar_minutes, rental_minutes, analytics_updated_at, formula_reference'
    );
    expect(query.eq).toHaveBeenCalledWith('asset_id', 'asset-1');

    const source = entityDetailPage.dataSources.assetAnalytics;
    expect(Boolean(evaluateExpression(source.enabled as string, createExpressionContext({ params: { entityType: 'asset', id: 'a1' } })))).toBe(true);
    expect(Boolean(evaluateExpression(source.enabled as string, createExpressionContext({ params: { entityType: 'invoice', id: 'i1' } })))).toBe(false);
  });
});
