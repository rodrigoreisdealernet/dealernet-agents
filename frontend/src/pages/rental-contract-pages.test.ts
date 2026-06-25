import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import rentalContractListPage from './rental-contract-list.json';
import rentalContractDetailPage from './rental-contract-detail.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('rental contract page definitions', () => {
  it('builds the rental contracts list query filtered by entity_type and current version', () => {
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
      rentalContractListPage.dataSources.contracts as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith(
      'id, entity_type, created_at, entity_versions!inner(id, data, is_current, version_number)'
    );
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'rental_contract');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('builds the related orders lookup query used for human-readable order references on the contracts list', () => {
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
      rentalContractListPage.dataSources.orders as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith('id, entity_versions!inner(data, is_current)');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'rental_order');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('fetches the contract entity as a single record by id from the detail page', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { id: 'contract-1' },
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
      rentalContractDetailPage.dataSources.contract as SupabaseDataSource,
      createExpressionContext({ params: { id: 'contract-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith('*, entity_versions(*)');
    expect(query.eq).toHaveBeenCalledWith('id', 'contract-1');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ id: 'contract-1' });
  });

  it('builds the contract lines query from v_rental_contract_line_current filtered by contract_id', () => {
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
      rentalContractDetailPage.dataSources.lines as SupabaseDataSource,
      createExpressionContext({ params: { id: 'contract-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('v_rental_contract_line_current');
    expect(query.select).toHaveBeenCalledWith(
      'entity_id, version_id, version_number, status, contract_id, asset_id, category_id, rental_type, rate_type, rate_amount, actual_start, actual_end, data'
    );
    expect(query.eq).toHaveBeenCalledWith('contract_id', 'contract-1');
    expect(query.order).toHaveBeenCalledWith('actual_start', { ascending: true });
  });

  it('builds the contract invoice lookup query scoped by contract_id', () => {
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
      rentalContractDetailPage.dataSources.contractInvoices as SupabaseDataSource,
      createExpressionContext({ params: { id: 'contract-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith('id, created_at, entity_versions!inner(data, is_current)');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'invoice');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.eq).toHaveBeenNthCalledWith(3, 'entity_versions.data->>contract_id', 'contract-1');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it('builds the contract invoice relationship lookup query scoped by contract_id', () => {
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
      rentalContractDetailPage.dataSources.contractInvoiceRelationships as SupabaseDataSource,
      createExpressionContext({ params: { id: 'contract-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('relationships_v2');
    expect(query.select).toHaveBeenCalledWith('parent_id, created_at');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'relationship_type', 'invoice:generated_from:contract');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'is_current', true);
    expect(query.eq).toHaveBeenNthCalledWith(3, 'child_id', 'contract-1');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it('builds the customers query from crm_customer_profile_current ordered by name', () => {
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
      rentalContractDetailPage.dataSources.customers as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('crm_customer_profile_current');
    expect(query.select).toHaveBeenCalledWith('entity_id, name');
    expect(query.order).toHaveBeenCalledWith('name', { ascending: true });
  });

  it('builds the detail-page orders lookup query used for source-order readable fallback text', () => {
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
      rentalContractDetailPage.dataSources.orders as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith('id, entity_versions!inner(data, is_current)');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'rental_order');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('builds the job_sites query from entities filtered by job_site entity type', () => {
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
      rentalContractDetailPage.dataSources.job_sites as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.select).toHaveBeenCalledWith('id, source_record_id, entity_versions!inner(data, is_current)');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'entity_type', 'job_site');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'entity_versions.is_current', true);
    expect(query.order).toHaveBeenCalledWith('source_record_id', { ascending: true });
  });

  it('builds the asset_categories query from rental_asset_availability_current ordered by name', () => {
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
      rentalContractDetailPage.dataSources.asset_categories as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('rental_asset_availability_current');
    expect(query.select).toHaveBeenCalledWith('asset_category_id, asset_category_name');
    expect(query.order).toHaveBeenCalledWith('asset_category_name', { ascending: true });
  });
});
