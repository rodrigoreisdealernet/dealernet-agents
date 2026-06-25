/**
 * Rental Contract List Route
 */

import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import { useDataSources } from '@/engine/useDataSources';
import rentalContractListPage from '@/pages/rental-contract-list.json';
import type { DataSourceDefinition, ExpressionContext, PageDefinition } from '@/engine/types';
import { ConflictAssistantPanel } from '@/components/rental/ConflictAssistantPanel';
import { buildOpenContractConflictQueue } from '@/lib/bookingConflictAssistant';
import { buildCustomerPortalRequestQueue } from '@/lib/customerPortalRequestQueue';

export const Route = createFileRoute('/rental/contracts/')({
  component: RentalContractListPage,
});

const contractQueueDataSources: Record<string, DataSourceDefinition> = {
  ...(rentalContractListPage as PageDefinition).dataSources,
  lines: {
    type: 'supabase',
    table: 'v_rental_contract_line_current',
    select: 'entity_id, contract_id, status, asset_id, category_id, actual_start, actual_end, data',
    order: [
      { column: 'contract_id', ascending: true },
      { column: 'actual_start', ascending: true },
    ],
  },
  availability: {
    type: 'supabase',
    table: 'rental_asset_availability_current',
    select: 'branch_id, branch_name, asset_category_id, asset_category_name, available_assets, unavailable_assets, maintenance_due_assets, maintenance_overdue_assets',
    order: [
      { column: 'branch_name', ascending: true },
      { column: 'asset_category_name', ascending: true },
    ],
  },
  customerRequests: {
    type: 'supabase',
    table: 'entities',
    select: 'id, created_at, entity_versions!inner(id, data, is_current, version_number)',
    filters: [
      { field: 'entity_type', op: 'eq', value: 'off_rent_request' },
      { field: 'entity_versions.is_current', op: 'eq', value: true },
    ],
    order: [{ column: 'created_at', ascending: false }],
  },
};

function RentalContractQueueAssistant() {
  const page = rentalContractListPage as PageDefinition;
  const context = useMemo<ExpressionContext>(
    () => ({
      state: page.state || {},
      data: {},
      params: {},
    }),
    [page.state],
  );
  const { data } = useDataSources(contractQueueDataSources, context);
  const result = useMemo(
    () => buildOpenContractConflictQueue({
      contracts: data.contracts,
      lines: data.lines,
      availability: data.availability,
    }),
    [data.availability, data.contracts, data.lines],
  );
  const customerRequestResult = useMemo(
    () => buildCustomerPortalRequestQueue({
      contracts: data.contracts,
      lines: data.lines,
      customerRequests: data.customerRequests,
    }),
    [data.contracts, data.customerRequests, data.lines],
  );

  return (
    <>
      <ConflictAssistantPanel
        title="Branch open-contract conflict queue"
        description="One canonical assist-only queue for delivery-window, return, and extension exceptions with evidence from open-contract and availability signals."
        result={result}
      />
      <ConflictAssistantPanel
        title="Customer request assist queue"
        description="Pickup/call-off, extension, and field-service requests captured from the portal with contract/equipment context and explicit evidence gaps."
        result={customerRequestResult}
      />
    </>
  );
}

export function RentalContractListScreen() {
  return (
    <>
      <UIEngine page={rentalContractListPage as PageDefinition} />
      <RentalContractQueueAssistant />
    </>
  );
}

function RentalContractListPage() {
  return <RentalContractListScreen />;
}
