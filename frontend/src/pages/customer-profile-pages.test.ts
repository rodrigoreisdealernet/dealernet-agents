import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import customerProfileListPage from './customer-profile-list.json';
import customerProfileDetailPage from './customer-profile-detail.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('customer profile page definitions', () => {
  it('builds the customer profile list query from the CRM read-model view', () => {
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
      customerProfileListPage.dataSources.customers as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('crm_customer_profile_current');
    expect(query.select).toHaveBeenCalledWith(
      'entity_id, source_record_id, name, customer_type, tier, industry, balance, credit_limit, payment_issue_flag, created_at'
    );
    expect(query.order).toHaveBeenCalledWith('name', { ascending: true });
  });

  it('fetches the customer profile detail as a single record keyed by id', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { entity_id: 'cust-1', name: 'Acme Corp' },
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
      customerProfileDetailPage.dataSources.profile as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'cust-1' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('crm_customer_profile_current');
    expect(query.select).toHaveBeenCalledWith(
      'entity_id, source_record_id, name, customer_type, tier, industry, hq_address, preferred_payment_method, preferences, payment_methods, balance, credit_limit, avg_days_to_pay, payment_issue_flag, last_interaction_type, last_interaction_summary, entity_version_id, version_number, valid_from, created_at, data'
    );
    expect(query.eq).toHaveBeenCalledWith('entity_id', 'cust-1');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ entity_id: 'cust-1', name: 'Acme Corp' });
  });

  it('queries contacts via the relationship graph filtered by parent_id', () => {
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
      customerProfileDetailPage.dataSources.contacts as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'cust-1' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('relationships_v2');
    expect(query.eq).toHaveBeenCalledWith('relationship_type', 'customer_has_contact');
    expect(query.eq).toHaveBeenCalledWith('parent_id', 'cust-1');
    expect(query.eq).toHaveBeenCalledWith('is_current', true);
  });

  it('queries notes via the relationship graph filtered by parent_id', () => {
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
      customerProfileDetailPage.dataSources.notes as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'cust-1' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('relationships_v2');
    expect(query.eq).toHaveBeenCalledWith('relationship_type', 'customer_has_note');
    expect(query.eq).toHaveBeenCalledWith('parent_id', 'cust-1');
    expect(query.eq).toHaveBeenCalledWith('is_current', true);
  });

  it('queries documents via the relationship graph filtered by parent_id', () => {
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
      customerProfileDetailPage.dataSources.documents as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'cust-1' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('relationships_v2');
    expect(query.eq).toHaveBeenCalledWith('relationship_type', 'customer_has_document');
    expect(query.eq).toHaveBeenCalledWith('parent_id', 'cust-1');
    expect(query.eq).toHaveBeenCalledWith('is_current', true);
  });

  it('queries version history ordered newest-first', () => {
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
      customerProfileDetailPage.dataSources.versions as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'cust-1' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('entity_versions');
    expect(query.eq).toHaveBeenCalledWith('entity_id', 'cust-1');
    expect(query.order).toHaveBeenCalledWith('version_number', { ascending: false });
  });

  it('queries durable customer issues from the CRM issue read model', () => {
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
      customerProfileDetailPage.dataSources.issues as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'cust-1' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('crm_customer_issue_current');
    expect(query.eq).toHaveBeenCalledWith('customer_id', 'cust-1');
    expect(query.order).toHaveBeenCalledWith('opened_at', { ascending: false });
  });

  it('queries communication timeline from the append-only CRM projection', () => {
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
      customerProfileDetailPage.dataSources.communication_timeline as SupabaseDataSource,
      createExpressionContext({
        params: { id: 'cust-1' },
      })
    );

    expect(client.from).toHaveBeenCalledWith('crm_customer_communication_timeline');
    expect(query.eq).toHaveBeenCalledWith('customer_id', 'cust-1');
    expect(query.order).toHaveBeenCalledWith('occurred_at', { ascending: false });
  });

  it('customer profile list page has required id and dataSources structure', () => {
    expect(customerProfileListPage.id).toBe('customer-profile-list');
    expect(customerProfileListPage.dataSources).toHaveProperty('customers');
    expect(customerProfileListPage.dataSources.customers.table).toBe('crm_customer_profile_current');
  });

  it('customer profile detail page has all required data sources', () => {
    expect(customerProfileDetailPage.id).toBe('customer-profile-detail');
    const sources = Object.keys(customerProfileDetailPage.dataSources);
    expect(sources).toContain('profile');
    expect(sources).toContain('contacts');
    expect(sources).toContain('notes');
    expect(sources).toContain('documents');
    expect(sources).toContain('billing_accounts');
    expect(sources).toContain('issues');
    expect(sources).toContain('communication_timeline');
    expect(sources).toContain('versions');
  });
});
