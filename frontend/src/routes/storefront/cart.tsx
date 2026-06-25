/**
 * Storefront Cart Route
 *
 * Presents a rental cart for a selected asset with damage waiver and delivery
 * add-ons, cross-sell recommendations, and a booking submission action.
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import storefrontCartPage from '@/pages/storefront-cart.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/storefront/cart')({
  validateSearch: (search: Record<string, unknown>) => ({
    asset_id: typeof search.asset_id === 'string' ? search.asset_id : undefined,
    start_date: typeof search.start_date === 'string' ? search.start_date : undefined,
    end_date: typeof search.end_date === 'string' ? search.end_date : undefined,
    rental_days: typeof search.rental_days === 'string' ? search.rental_days : undefined,
  }),
  component: StorefrontCartPage,
});

interface StorefrontCartScreenProps {
  assetId?: string;
  startDate?: string;
  endDate?: string;
  rentalDays?: string;
}

export function StorefrontCartScreen({
  assetId,
  startDate,
  endDate,
  rentalDays,
}: StorefrontCartScreenProps = {}) {
  const params: Record<string, string> = {
    asset_id: assetId ?? '',
    start_date: startDate ?? '',
    end_date: endDate ?? '',
    rental_days: rentalDays ?? '1',
  };

  return (
    <UIEngine
      key={`${assetId ?? ''}:${startDate ?? ''}:${endDate ?? ''}:${rentalDays ?? ''}`}
      page={storefrontCartPage as PageDefinition}
      params={params}
    />
  );
}

function StorefrontCartPage() {
  const { asset_id, start_date, end_date, rental_days } = Route.useSearch();
  return (
    <StorefrontCartScreen
      assetId={asset_id}
      startDate={start_date}
      endDate={end_date}
      rentalDays={rental_days}
    />
  );
}
