/**
 * Rental Order List Route
 */

import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import rentalOrderListPage from '@/pages/rental-order-list.json';
import type { FilterDefinition, PageDefinition, SupabaseDataSource } from '@/engine/types';

function readScopeParam(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const Route = createFileRoute('/rental/orders/')({
  validateSearch: (search: Record<string, unknown>) => ({
    branch_id: readScopeParam(search.branch_id),
    category_id: readScopeParam(search.category_id),
  }),
  component: RentalOrderListPage,
});

interface RentalOrderListScreenProps {
  branchId?: string;
  categoryId?: string;
}

export function RentalOrderListScreen({ branchId, categoryId }: RentalOrderListScreenProps = {}) {
  const page = useMemo<PageDefinition>(() => {
    const base = rentalOrderListPage as PageDefinition;
    if (!branchId && !categoryId) return base;

    const filters: FilterDefinition[] = [];
    if (branchId) filters.push({ field: 'branch_id', op: 'eq', value: branchId });
    if (categoryId) filters.push({ field: 'asset_category_id', op: 'eq', value: categoryId });

    const baseAvailability = base.dataSources?.availability;
    const baseAvailabilityFilters = baseAvailability
      ? ((baseAvailability as SupabaseDataSource).filters || [])
      : [];

    return {
      ...base,
      state: {
        ...(base.state || {}),
        ...(branchId ? { newOrder_scope_branch_id: branchId } : {}),
        ...(categoryId ? { newOrder_scope_category_id: categoryId } : {}),
        ...(categoryId ? { newOrder_line_category_id: categoryId } : {}),
      },
      dataSources: baseAvailability
        ? {
            ...base.dataSources,
            availability: {
              ...(baseAvailability as SupabaseDataSource),
              filters: [...baseAvailabilityFilters, ...filters],
            },
          }
        : base.dataSources,
    };
  }, [branchId, categoryId]);

  return <UIEngine page={page} />;
}

export function RentalOrderListPage() {
  const { branch_id, category_id } = Route.useSearch();
  return <RentalOrderListScreen branchId={branch_id} categoryId={category_id} />;
}
