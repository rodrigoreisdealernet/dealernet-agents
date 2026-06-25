import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext, evaluateExpression } from '@/engine/ExpressionEvaluator';
import equipmentCatalogPage from './equipment-catalog.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('equipment catalog page definitions', () => {
  it('builds the assets query filtered by entity_type=asset and current version', () => {
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
      equipmentCatalogPage.dataSources.assets as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith(
      'id, entity_type, created_at, entity_versions!inner(id, data, is_current)'
    );
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'asset');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: true });
  });

  it('builds the categories query filtered by entity_type=asset_category', () => {
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
      equipmentCatalogPage.dataSources.categories as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'asset_category');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
  });

  it('builds the branches query filtered by entity_type=branch', () => {
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
      equipmentCatalogPage.dataSources.branches as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'branch');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
  });

  it('formatCurrency renders a rate correctly and never shows bare dollar artifact', () => {
    const ctx = createExpressionContext({
      data: {
        asset: { entity_versions: [{ data: { daily_rate: 250, weekly_rate: 1200, monthly_rate: 4000 } }] },
      },
    });
    const dailyResult = evaluateExpression('{{250 ? formatCurrency(250) : "—"}}', ctx);
    expect(dailyResult).not.toBe('$');
    expect(dailyResult).not.toContain('$ ');
    expect(String(dailyResult)).toMatch(/^\$\d/);
  });

  it('null rate expression returns em-dash not a bare dollar sign', () => {
    const ctx = createExpressionContext();
    const result = evaluateExpression('{{null ? formatCurrency(null) : "—"}}', ctx);
    expect(result).toBe('—');
    expect(result).not.toBe('$');
    expect(result).not.toContain('$');
  });
});
