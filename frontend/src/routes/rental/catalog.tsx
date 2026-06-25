/**
 * Equipment Catalog Route
 */

import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import equipmentCatalogPage from '@/pages/equipment-catalog.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/rental/catalog')({
  validateSearch: (search: Record<string, unknown>) => ({
    category_id: typeof search.category_id === 'string' ? search.category_id : undefined,
    branch_id: typeof search.branch_id === 'string' ? search.branch_id : undefined,
    search: typeof search.search === 'string' ? search.search : undefined,
  }),
  component: EquipmentCatalogPage,
});

interface EquipmentCatalogScreenProps {
  categoryId?: string;
  branchId?: string;
  search?: string;
}

export function EquipmentCatalogScreen({ categoryId, branchId, search }: EquipmentCatalogScreenProps = {}) {
  const navigate = useNavigate();

  const handleStateChange = useCallback((
    nextState: Record<string, unknown>,
    previousState: Record<string, unknown>
  ) => {
    const nextCategoryId = typeof nextState.selectedCategory === 'string' ? nextState.selectedCategory : '';
    const nextBranchId = typeof nextState.selectedBranch === 'string' ? nextState.selectedBranch : '';
    const nextSearch = typeof nextState.searchText === 'string' ? nextState.searchText : '';
    const previousCategoryId = typeof previousState.selectedCategory === 'string' ? previousState.selectedCategory : '';
    const previousBranchId = typeof previousState.selectedBranch === 'string' ? previousState.selectedBranch : '';
    const previousSearch = typeof previousState.searchText === 'string' ? previousState.searchText : '';

    if (
      nextCategoryId === previousCategoryId &&
      nextBranchId === previousBranchId &&
      nextSearch === previousSearch
    ) {
      return;
    }

    navigate({
      to: '/rental/catalog',
      replace: true,
      search: {
        category_id: nextCategoryId || undefined,
        branch_id: nextBranchId || undefined,
        search: nextSearch || undefined,
      },
    });
  }, [navigate]);

  const page = useMemo<PageDefinition>(() => {
    const base = equipmentCatalogPage as PageDefinition;

    return {
      ...base,
      state: {
        ...(base.state || {}),
        selectedCategory: categoryId || '',
        selectedBranch: branchId || '',
        searchText: search || '',
      },
    };
  }, [branchId, categoryId, search]);

  return (
    <UIEngine
      key={`${categoryId ?? ''}:${branchId ?? ''}:${search ?? ''}`}
      page={page}
      onStateChange={handleStateChange}
    />
  );
}

function EquipmentCatalogPage() {
  const { category_id, branch_id, search } = Route.useSearch();
  return <EquipmentCatalogScreen categoryId={category_id} branchId={branch_id} search={search} />;
}
