import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import branchOpsDashboardPage from './branch-ops-dashboard.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('branch-ops dashboard page definitions', () => {
  it('queries branch utilization from v_branch_utilization ordered by branch name', () => {
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
      branchOpsDashboardPage.dataSources.utilization as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_branch_utilization');
    expect(query.select).toHaveBeenCalledWith(
      'branch_id, branch_name, on_rent_count, utilization_rate_pct, last_updated'
    );
    expect(query.order).toHaveBeenCalledWith('branch_name', { ascending: true });
  });

  it('queries in-flight transfers from v_current_assets filtered by on_transfer status', () => {
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
      branchOpsDashboardPage.dataSources.in_flight as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_current_assets');
    expect(query.select).toHaveBeenCalledWith(
      'asset_id, name, serial_number, status, category_id'
    );
    expect(query.eq).toHaveBeenCalledWith('status', 'on_transfer');
    expect(query.order).toHaveBeenCalledWith('name', { ascending: true });
  });

  it('queries availability from rental_asset_availability_current with compatibility-safe select', () => {
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
      branchOpsDashboardPage.dataSources.availability as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('rental_asset_availability_current');
    expect(query.select).toHaveBeenCalledWith('*');
    expect(query.order).toHaveBeenNthCalledWith(1, 'branch_name', { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, 'asset_category_name', { ascending: true });
  });
});
