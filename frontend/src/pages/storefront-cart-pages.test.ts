import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import storefrontCartPage from './storefront-cart.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('storefront cart page definition', () => {
  it('queries the asset table filtered by id and entity_type', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      storefrontCartPage.dataSources.asset as SupabaseDataSource,
      createExpressionContext({ params: { asset_id: 'asset-001' } })
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.eq).toHaveBeenCalledWith('id', 'asset-001');
    expect(query.eq).toHaveBeenCalledWith('entity_type', 'asset');
    expect(query.eq).toHaveBeenCalledWith('entity_versions.is_current', true);
  });

  it('queries relatedAssets for all available assets', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      storefrontCartPage.dataSources.relatedAssets as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.eq).toHaveBeenCalledWith('entity_type', 'asset');
    expect(query.eq).toHaveBeenCalledWith('entity_versions.is_current', true);
  });

  it('page definition has the expected initial state', () => {
    expect(storefrontCartPage.state).toEqual({
      damageWaiverEnabled: false,
      deliveryEnabled: false,
    });
  });

  it('page title is Rental Cart', () => {
    expect(storefrontCartPage.title).toBe('Rental Cart');
  });
});
