import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import fleetReportingDashboardPage from './fleet-reporting-dashboard.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('fleet reporting dashboard page definitions', () => {
  it('queries branch utilization from v_branch_utilization ordered by branch', () => {
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
      fleetReportingDashboardPage.dataSources.utilization_by_branch as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_branch_utilization');
    expect(query.select).toHaveBeenCalledWith(
      'branch_id, branch_name, on_rent_count, utilization_rate_pct, last_updated'
    );
    expect(query.order).toHaveBeenCalledWith('branch_name', { ascending: true });
  });

  it('queries branch/category utilization from rental_asset_availability_current', () => {
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
      fleetReportingDashboardPage.dataSources.utilization_by_category as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('rental_asset_availability_current');
    expect(query.select).toHaveBeenCalledWith(
      'branch_id, branch_name, asset_category_id, asset_category_name, total_assets, available_assets, unavailable_assets'
    );
    expect(query.order).toHaveBeenNthCalledWith(1, 'branch_name', { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, 'asset_category_name', { ascending: true });
  });

  it('queries invoice revenue from invoice entities with current versions only', () => {
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
      fleetReportingDashboardPage.dataSources.invoice_revenue as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith(
      'id, source_record_id, entity_versions!inner(data, is_current, valid_from)'
    );
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'invoice');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(25);
  });

  it('queries downtime history from v_asset_downtime_history ordered newest first', () => {
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
      fleetReportingDashboardPage.dataSources.asset_downtime as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_asset_downtime_history');
    expect(query.select).toHaveBeenCalledWith(
      'asset_id, downtime_recorded_at, downtime_minutes, maintenance_record_id'
    );
    expect(query.order).toHaveBeenCalledWith('downtime_recorded_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(25);
  });

  it('queries per-asset analytics from v_asset_analytics_current ordered by revenue', () => {
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
      fleetReportingDashboardPage.dataSources.asset_analytics as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_asset_analytics_current');
    expect(query.select).toHaveBeenCalledWith(
      'asset_id, asset_name, asset_category_name, branch_name, ownership_type, lifetime_revenue, utilization_pct, downtime_pct, total_downtime_minutes, rental_frequency, roi_pct, roi_status, last_order_at'
    );
    expect(query.order).toHaveBeenCalledWith('lifetime_revenue', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(20);
  });

  it('queries asset identity details from rental_current_assets ordered by name without truncation', () => {
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
      fleetReportingDashboardPage.dataSources.asset_identity,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('rental_current_assets');
    expect(query.select).toHaveBeenCalledWith(
      'entity_id, name, data, current_asset_category_name, current_branch_name'
    );
    expect(query.order).toHaveBeenCalledWith('name', { ascending: true });
    expect(query.limit).not.toHaveBeenCalled();
  });
});
