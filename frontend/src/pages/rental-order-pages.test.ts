import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import rentalOrderListPage from './rental-order-list.json';
import rentalOrderDetailPage from './rental-order-detail.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('rental order page definitions', () => {
  it('builds the rental orders list query filtered by entity_type and current version', () => {
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
      rentalOrderListPage.dataSources.orders as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith(
      'id, entity_type, created_at, entity_versions!inner(id, data, is_current, version_number)'
    );
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'rental_order');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('queries availability from rental_asset_availability_current for the list page', () => {
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
      rentalOrderListPage.dataSources.availability as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('rental_asset_availability_current');
    expect(query.select).toHaveBeenCalledWith(
      'branch_id, branch_name, asset_category_id, asset_category_name, total_assets, available_assets'
    );
    expect(query.order).toHaveBeenNthCalledWith(1, 'branch_name', { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, 'asset_category_name', { ascending: true });
  });

  it('fetches the order entity as a single record by id from the detail page', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { id: 'order-1' },
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
      rentalOrderDetailPage.dataSources.order as SupabaseDataSource,
      createExpressionContext({ params: { id: 'order-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith('*, entity_versions(*)');
    expect(query.eq).toHaveBeenCalledWith('id', 'order-1');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ id: 'order-1' });
  });

  it('builds the order lines query filtered by entity_type and order_id', () => {
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
      rentalOrderDetailPage.dataSources.lines as SupabaseDataSource,
      createExpressionContext({ params: { id: 'order-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.eq).toHaveBeenCalledWith('entity_type', 'rental_order_line');
    expect(query.eq).toHaveBeenCalledWith('entity_versions.is_current', true);
    expect(query.eq).toHaveBeenCalledWith('entity_versions.data->>order_id', 'order-1');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: true });
  });

  it('queries requester, job site, and asset category lookup data for the detail page', () => {
    const requestersQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const jobSitesQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const assetCategoriesQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn()
        .mockReturnValueOnce(requestersQuery)
        .mockReturnValueOnce(jobSitesQuery)
        .mockReturnValueOnce(assetCategoriesQuery),
    };

    buildSupabaseQuery(
      client as never,
      rentalOrderDetailPage.dataSources.requesters as SupabaseDataSource,
      createExpressionContext()
    );
    buildSupabaseQuery(
      client as never,
      rentalOrderDetailPage.dataSources.job_sites as SupabaseDataSource,
      createExpressionContext()
    );
    buildSupabaseQuery(
      client as never,
      rentalOrderDetailPage.dataSources.asset_categories as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenNthCalledWith(1, 'entities');
    expect(requestersQuery.select).toHaveBeenCalledWith('id, source_record_id, entity_versions!inner(data, is_current)');
    expect(requestersQuery.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'customer');
    expect(requestersQuery.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(requestersQuery.order).toHaveBeenCalledWith('source_record_id', { ascending: true });

    expect(client.from).toHaveBeenNthCalledWith(2, 'entities');
    expect(jobSitesQuery.select).toHaveBeenCalledWith('id, source_record_id, entity_versions!inner(data, is_current)');
    expect(jobSitesQuery.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'job_site');
    expect(jobSitesQuery.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(jobSitesQuery.order).toHaveBeenCalledWith('source_record_id', { ascending: true });

    expect(client.from).toHaveBeenNthCalledWith(3, 'entities');
    expect(assetCategoriesQuery.select).toHaveBeenCalledWith('id, source_record_id, entity_versions!inner(data, is_current)');
    expect(assetCategoriesQuery.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'asset_category');
    expect(assetCategoriesQuery.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(assetCategoriesQuery.order).toHaveBeenCalledWith('source_record_id', { ascending: true });
  });

  it('queries availability from rental_asset_availability_current for the detail page', () => {
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
      rentalOrderDetailPage.dataSources.availability as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('rental_asset_availability_current');
    const availabilitySelect = rentalOrderDetailPage.dataSources.availability.select;
    expect(query.select).toHaveBeenCalledWith(availabilitySelect);
    expect(availabilitySelect).toBe(
      'branch_id, branch_name, asset_category_id, asset_category_name, total_assets, available_assets, unavailable_assets, maintenance_due_assets, maintenance_overdue_assets'
    );
    expect(availabilitySelect).not.toContain('item_type');
    expect(availabilitySelect).not.toContain('missed_rental');
  });

  it('queries quote availability from rental_quote_line_availability_current for the detail page', () => {
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
      rentalOrderDetailPage.dataSources.quote_availability as SupabaseDataSource,
      createExpressionContext({ params: { id: 'order-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('rental_quote_line_availability_current');
    expect(query.eq).toHaveBeenCalledWith('order_id', 'order-1');
    expect(query.order).toHaveBeenCalledWith('line_entity_id', { ascending: true });
  });
});
