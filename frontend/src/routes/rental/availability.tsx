/**
 * Rental Branch Availability Route
 */

import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import availabilityPage from '@/pages/rental-availability.json';
import type { PageDefinition, SupabaseDataSource, FilterDefinition } from '@/engine/types';

export const Route = createFileRoute('/rental/availability')({
  validateSearch: (search: Record<string, unknown>) => ({
    branch_id: typeof search.branch_id === 'string' ? search.branch_id : undefined,
    category_id: typeof search.category_id === 'string' ? search.category_id : undefined,
  }),
  component: RentalAvailabilityPage,
});

interface RentalAvailabilityScreenProps {
  branchId?: string;
  categoryId?: string;
}

export function RentalAvailabilityScreen({ branchId, categoryId }: RentalAvailabilityScreenProps = {}) {
  const page = useMemo<PageDefinition>(() => {
    const base = availabilityPage as PageDefinition;
    const filters: FilterDefinition[] = [];
    if (branchId) filters.push({ field: 'branch_id', op: 'eq', value: branchId });
    if (categoryId) filters.push({ field: 'asset_category_id', op: 'eq', value: categoryId });
    if (filters.length === 0) return base;
    const baseAvail = base.dataSources?.availability;
    // If the page definition has no availability source (e.g. in tests or future
    // page variants), return the base page unchanged rather than breaking.
    if (!baseAvail) return base;
    return {
      ...base,
      dataSources: {
        ...base.dataSources,
        availability: {
          ...(baseAvail as SupabaseDataSource),
          filters,
        },
      },
    };
  }, [branchId, categoryId]);

  const params = { branch_id: branchId ?? '', category_id: categoryId ?? '' };
  return <UIEngine page={page} params={params} />;
}

function RentalAvailabilityPage() {
  const { branch_id, category_id } = Route.useSearch();
  return <RentalAvailabilityScreen branchId={branch_id} categoryId={category_id} />;
}
