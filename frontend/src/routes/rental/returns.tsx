/**
 * Rental Returns / Check-In Route
 */

import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import returnsCheckInPage from '@/pages/rental-returns-checkin.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/rental/returns')({
  validateSearch: (search: Record<string, unknown>) => ({
    asset_id: typeof search.asset_id === 'string' ? search.asset_id : undefined,
  }),
  component: RentalReturnsCheckInPage,
});

interface RentalReturnsCheckInScreenProps {
  assetId?: string;
}

export function RentalReturnsCheckInScreen({ assetId }: RentalReturnsCheckInScreenProps = {}) {
  const page = useMemo<PageDefinition>(() => {
    const base = returnsCheckInPage as PageDefinition;
    if (!assetId) return base;
    return {
      ...base,
      state: {
        ...(base.state || {}),
        checkIn_asset_id: assetId,
      },
    };
  }, [assetId]);

  return <UIEngine page={page} />;
}

function RentalReturnsCheckInPage() {
  const { asset_id } = Route.useSearch();
  return <RentalReturnsCheckInScreen assetId={asset_id} />;
}
