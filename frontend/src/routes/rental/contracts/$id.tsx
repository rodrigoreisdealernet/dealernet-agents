/**
 * Rental Contract Detail Route
 */

import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import { useDataSources } from '@/engine/useDataSources';
import rentalContractDetailPage from '@/pages/rental-contract-detail.json';
import type { DataSourceDefinition, ExpressionContext, PageDefinition } from '@/engine/types';
import { ConflictAssistantPanel } from '@/components/rental/ConflictAssistantPanel';
import { buildOpenContractConflictQueue } from '@/lib/bookingConflictAssistant';

export const Route = createFileRoute('/rental/contracts/$id')({
  component: RentalContractDetailPage,
});

interface RentalContractDetailScreenProps {
  id: string;
}

const contractConflictDataSources: Record<string, DataSourceDefinition> = {
  ...(rentalContractDetailPage as PageDefinition).dataSources,
  availability: {
    type: 'supabase',
    table: 'rental_asset_availability_current',
    select: 'branch_id, branch_name, asset_category_id, asset_category_name, available_assets, unavailable_assets, maintenance_due_assets, maintenance_overdue_assets',
    order: [
      { column: 'branch_name', ascending: true },
      { column: 'asset_category_name', ascending: true },
    ],
  },
};

function RentalContractConflictAssistant({ id }: { id: string }) {
  const page = rentalContractDetailPage as PageDefinition;
  const context = useMemo<ExpressionContext>(
    () => ({
      state: page.state || {},
      data: {},
      params: { id },
    }),
    [id, page.state],
  );
  const { data } = useDataSources(contractConflictDataSources, context);
  const result = useMemo(
    () => buildOpenContractConflictQueue({
      contracts: data.contract ? [data.contract] : [],
      lines: data.lines,
      availability: data.availability,
    }),
    [data.availability, data.contract, data.lines],
  );

  return (
    <ConflictAssistantPanel
      title="Booking & extension conflict assistant"
      description="Assist-only branch review for delivery-window, return, and extension conflicts before any customer-facing promise changes."
      result={result}
    />
  );
}

export function RentalContractDetailScreen({ id }: RentalContractDetailScreenProps) {
  return (
    <>
      <UIEngine
        page={rentalContractDetailPage as PageDefinition}
        params={{ id }}
      />
      <RentalContractConflictAssistant id={id} />
    </>
  );
}

function RentalContractDetailPage() {
  const { id } = Route.useParams();
  return <RentalContractDetailScreen id={id} />;
}
