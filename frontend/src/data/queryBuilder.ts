/**
 * Supabase Query Builder
 *
 * Transforms DataSourceDefinition into Supabase queries
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Inferred type of the filter-capable builder returned by client.from().select() */
type SelectQuery = ReturnType<ReturnType<SupabaseClient['from']>['select']>;
import type {
  SupabaseDataSource,
  FilterDefinition,
  ExpressionContext,
} from '@/engine/types';
import { evaluateExpression } from '@/engine/ExpressionEvaluator';

function normalizeVersionNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function getEntityVersionMeta(value: unknown): { isCurrent: boolean; versionNumber: number } {
  if (!value || typeof value !== 'object') {
    return { isCurrent: false, versionNumber: Number.NEGATIVE_INFINITY };
  }

  const record = value as { is_current?: unknown; version_number?: unknown };
  return {
    isCurrent: record.is_current === true,
    versionNumber: normalizeVersionNumber(record.version_number),
  };
}

function normalizeEntityVersions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeEntityVersions(item));
  }

  if (value && typeof value === 'object') {
    const normalizedRecord = Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, normalizeEntityVersions(entryValue)])
    ) as Record<string, unknown>;

    const entityVersions = normalizedRecord.entity_versions;
    if (Array.isArray(entityVersions)) {
      normalizedRecord.entity_versions = [...entityVersions].sort((left, right) => {
        const leftMeta = getEntityVersionMeta(left);
        const rightMeta = getEntityVersionMeta(right);
        if (leftMeta.isCurrent !== rightMeta.isCurrent) {
          return leftMeta.isCurrent ? -1 : 1;
        }
        return rightMeta.versionNumber - leftMeta.versionNumber;
      });
    }

    return normalizedRecord;
  }

  return value;
}

/**
 * Apply a filter to a Supabase query
 */
function applyFilter(
  query: SelectQuery,
  filter: FilterDefinition,
  context: ExpressionContext
): SelectQuery {
  const value = evaluateExpression(filter.value, context);

  switch (filter.op) {
    case 'eq':
      return query.eq(filter.field, value);
    case 'neq':
      return query.neq(filter.field, value);
    case 'gt':
      return query.gt(filter.field, value);
    case 'gte':
      return query.gte(filter.field, value);
    case 'lt':
      return query.lt(filter.field, value);
    case 'lte':
      return query.lte(filter.field, value);
    case 'like':
      return query.like(filter.field, value as string);
    case 'ilike':
      return query.ilike(filter.field, value as string);
    case 'in':
      return query.in(filter.field, value as unknown[]);
    case 'is':
      return query.is(filter.field, value);
    case 'contains':
      return query.contains(filter.field, value as unknown[]);
    case 'containedBy':
      return query.containedBy(filter.field, value as unknown[]);
    default:
      console.warn(`Unknown filter operator: ${filter.op}`);
      return query;
  }
}

/**
 * Build a Supabase query from a data source definition
 */
export function buildSupabaseQuery(
  client: SupabaseClient,
  source: SupabaseDataSource,
  context: ExpressionContext
) {
  if (!source.table) {
    throw new Error('buildSupabaseQuery: source.table is required (rpc sources are not supported in this function)');
  }
  // Start with the table and select
  let query: SelectQuery = client
    .from(source.table)
    .select(source.select || '*');

  // Apply filters
  if (source.filters) {
    for (const filter of source.filters) {
      query = applyFilter(query, filter, context) as typeof query;
    }
  }

  // Apply ordering
  if (source.order) {
    for (const order of source.order) {
      query = query.order(order.column, {
        ascending: order.ascending ?? true,
        ...(order.referencedTable ? { referencedTable: order.referencedTable } : {}),
      });
    }
  }

  // Apply limit
  if (source.limit) {
    query = query.limit(source.limit);
  }

  return query;
}

/**
 * Execute a Supabase query and handle single vs multiple results
 */
export async function executeSupabaseQuery(
  client: SupabaseClient,
  source: SupabaseDataSource,
  context: ExpressionContext
): Promise<unknown> {
  // RPC path
  if (source.rpc) {
    const params = source.params
      ? Object.fromEntries(
          Object.entries(source.params).map(([k, v]) => [k, evaluateExpression(v, context)])
        )
      : {};
    const { data, error } = await client.rpc(source.rpc, params);
    if (error) throw error;
    return normalizeEntityVersions(data);
  }

  // Table/view path
  const query = buildSupabaseQuery(client, source, context);

  if (source.single) {
    const { data, error } = await query.single();
    if (error) throw error;
    return normalizeEntityVersions(data);
  }

  const { data, error } = await query;
  if (error) throw error;
  return normalizeEntityVersions(data);
}

/**
 * Create a query key for TanStack Query
 */
export function createQueryKey(
  source: SupabaseDataSource,
  context: ExpressionContext
): unknown[] {
  // RPC path: key on function name + evaluated params
  if (source.rpc) {
    const evaluatedParams = source.params
      ? Object.fromEntries(
          Object.entries(source.params).map(([k, v]) => [k, evaluateExpression(v, context)])
        )
      : {};
    return ['supabase', 'rpc', source.rpc, evaluatedParams];
  }

  // Evaluate filter values to include in query key
  const evaluatedFilters = source.filters?.map((f) => ({
    ...f,
    value: evaluateExpression(f.value, context),
  }));

  return [
    'supabase',
    source.table,
    source.select || '*',
    evaluatedFilters,
    source.order,
    source.limit,
    source.single,
  ];
}
