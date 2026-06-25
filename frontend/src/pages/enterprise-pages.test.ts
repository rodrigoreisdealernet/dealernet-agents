import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import orgHierarchyPage from './org-hierarchy.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('org hierarchy page definitions', () => {
  it('queries companies from rental_current_companies ordered by name', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      orgHierarchyPage.dataSources.companies as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('rental_current_companies');
    expect(query.select).toHaveBeenCalledWith('entity_id, name, data');
    expect(query.order).toHaveBeenCalledWith('name', { ascending: true });
  });

  it('queries hierarchy rows from v_org_scope_hierarchy filtered to depth > 0 and ordered', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      orgHierarchyPage.dataSources.hierarchy as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_org_scope_hierarchy');
    expect(query.select).toHaveBeenCalledWith(
      'ancestor_id, ancestor_entity_type, ancestor_name, descendant_id, descendant_entity_type, descendant_name, depth'
    );
    expect(query.gt).toHaveBeenCalledWith('depth', 0);
    expect(query.order).toHaveBeenNthCalledWith(1, 'ancestor_name', { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, 'depth', { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(3, 'descendant_name', { ascending: true });
  });

  it('queries scope config from v_org_scope_config ordered by entity_type then name', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      orgHierarchyPage.dataSources.scopeConfig as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_org_scope_config');
    expect(query.select).toHaveBeenCalledWith(
      'scope_id, entity_type, name, default_currency_code, locale_code, tax_region_code, timezone'
    );
    expect(query.order).toHaveBeenNthCalledWith(1, 'entity_type', { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, 'name', { ascending: true });
  });

  it('page id and title match the org hierarchy surface', () => {
    expect(orgHierarchyPage.id).toBe('org-hierarchy');
    expect(orgHierarchyPage.title).toBe('Org Hierarchy');
  });

  it('hierarchy data source has the depth > 0 filter to exclude self-rows', () => {
    const filters = orgHierarchyPage.dataSources.hierarchy.filters ?? [];
    const depthFilter = filters.find((f) => f.field === 'depth');
    expect(depthFilter).toBeDefined();
    expect(depthFilter?.op).toBe('gt');
    expect(depthFilter?.value).toBe(0);
  });
});
