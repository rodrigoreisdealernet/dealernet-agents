import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import transferManagementPage from './transfer-management.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('transfer-management page definitions', () => {
  it('queries v_transfer_current for in-transit transfers filtered by status=in_transit', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      transferManagementPage.dataSources.in_transit as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_transfer_current');
    expect(query.eq).toHaveBeenCalledWith('status', 'in_transit');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('queries v_transfer_history for full transfer history', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      transferManagementPage.dataSources.transfers as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_transfer_history');
    expect(query.eq).not.toHaveBeenCalledWith('status', 'in_transit');
    expect(query.order).toHaveBeenCalledWith('transitioned_at', { ascending: false });
  });

  it('transfer history datasource orders by transitioned_at (per-version field) not created_at', () => {
    const ds = transferManagementPage.dataSources.transfers;
    expect(ds.order).toBeDefined();
    const orderColumns = (ds.order as { column: string; ascending: boolean }[]).map((o) => o.column);
    expect(orderColumns).toContain('transitioned_at');
    expect(orderColumns).not.toContain('created_at');
  });

  it('transfer history datasource selects version_id for per-version unique row keys', () => {
    const ds = transferManagementPage.dataSources.transfers;
    expect(ds.select).toContain('version_id');
    expect(ds.select).toContain('version_number');
    expect(ds.select).toContain('transitioned_at');
  });

  it('history row key uses version_id so multiple versions of one transfer render as distinct rows', () => {
    // The history "each" loop must key on version_id, not transfer_entity_id.
    // This ensures that a transfer with 3 lifecycle versions produces 3 distinct rows.
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    // The key pattern in the history card each loop must reference version_id
    // (JSON.stringify produces no spaces around ":")
    expect(jsonStr).toContain('"key":"{{xfer.version_id}}"');
    // It must NOT use transfer_entity_id as the sole key anywhere in the history layout
    // (transfer_entity_id would collide across versions of the same transfer)
    expect(jsonStr).not.toContain('"key":"{{xfer.transfer_entity_id}}"');
  });

  it('selects origin and destination branch and project columns for in-transit transfers', () => {
    const ds = transferManagementPage.dataSources.in_transit;
    expect(ds.select).toContain('origin_branch_id');
    expect(ds.select).toContain('origin_branch_name');
    expect(ds.select).toContain('destination_branch_id');
    expect(ds.select).toContain('destination_branch_name');
    expect(ds.select).toContain('origin_project_id');
    expect(ds.select).toContain('origin_project_name');
    expect(ds.select).toContain('destination_project_id');
    expect(ds.select).toContain('destination_project_name');
  });

  it('selects responsible user columns (requested_by, dispatched_by, received_by) for in-transit view', () => {
    const ds = transferManagementPage.dataSources.in_transit;
    expect(ds.select).toContain('requested_by');
    expect(ds.select).toContain('dispatched_by');
    expect(ds.select).toContain('received_by');
  });

  it('selects all responsible user columns including approved_by in transfer history', () => {
    const ds = transferManagementPage.dataSources.transfers;
    expect(ds.select).toContain('requested_by');
    expect(ds.select).toContain('approved_by');
    expect(ds.select).toContain('dispatched_by');
    expect(ds.select).toContain('received_by');
  });

  it('renders an in-transit section with count badge and details', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('In Transit');
    expect(jsonStr).toContain('in transit');
    expect(jsonStr).toContain('No equipment currently in transit');
  });

  it('renders origin and destination with project context in in-transit cards', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('origin_branch_name');
    expect(jsonStr).toContain('origin_project_name');
    expect(jsonStr).toContain('destination_branch_name');
    expect(jsonStr).toContain('destination_project_name');
    expect(jsonStr).toContain('ORIGIN');
    expect(jsonStr).toContain('DESTINATION');
  });

  it('shows dispatch and schedule details for in-transit transfers', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('dispatched_by');
    expect(jsonStr).toContain('requested_ship_date');
    expect(jsonStr).toContain('expected_receive_date');
  });

  it('renders transfer history section with full responsible-user and date columns', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('Transfer History');
    expect(jsonStr).toContain('approved_by');
    expect(jsonStr).toContain('actual_ship_at');
    expect(jsonStr).toContain('actual_receive_at');
  });

  it('links each transfer card to the entity detail page', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('/entities/transfer/{{xfer.transfer_entity_id}}');
    expect(jsonStr).toContain('View details');
  });

  it('uses filtered result length for transfer history badge pluralisation', () => {
    // The badge must count against the filtered array, not the raw data array,
    // so the singular/plural form is correct when filters narrow the results.
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    // The length check should NOT use raw data.transfers.length === 1 for plural
    expect(jsonStr).not.toContain("data.transfers.length === 1 ? '' : 's'");
  });

  it('exposes branch and project filters in state', () => {
    expect(transferManagementPage.state).toHaveProperty('branchFilter');
    expect(transferManagementPage.state).toHaveProperty('projectFilter');
    expect(transferManagementPage.state).toHaveProperty('statusFilter');
  });

  it('shows transfer exception alerts when transfer_exception_reason is present', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('transfer_exception_reason');
    expect(jsonStr).toContain('Exception');
  });

  it('in-transit data source has a 15-second refetch interval', () => {
    expect(transferManagementPage.dataSources.in_transit as SupabaseDataSource).toHaveProperty('refetchInterval', 15000);
  });

  it('exposes a page-level Request Transfer action button', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('Request Transfer');
  });

  it('Request Transfer button is gated behind auth.canWrite', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('"if":"{{auth.canWrite}}"');
  });

  it('Request Transfer button opens the requestTransfer modal', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('"modalId":"requestTransfer"');
  });

  it('page defines a requestTransfer modal', () => {
    expect(transferManagementPage.modals).toBeDefined();
    expect(transferManagementPage.modals).toHaveProperty('requestTransfer');
  });

  it('requestTransfer modal calls create_entity_with_version rpc with status requested', () => {
    const jsonStr = JSON.stringify(transferManagementPage.modals);
    expect(jsonStr).toContain('create_entity_with_version');
    expect(jsonStr).toContain('"status":"requested"');
  });

  it('in-transit cards expose a Receive action button', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    // The in-transit section must include a Receive button
    expect(jsonStr).toContain('"Receive"');
    // The Receive button must open the receiveTransfer modal
    expect(jsonStr).toContain('"modalId":"receiveTransfer"');
  });

  it('in-transit Receive button is gated behind auth.canOperate', () => {
    // The in-transit Receive button must not be visible to read-only users
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('"if":"{{auth.canOperate}}"');
  });

  it('history cards expose a conditional Approve button for requested-status rows', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('"Approve"');
    expect(jsonStr).toContain("status === 'requested'");
    expect(jsonStr).toContain('"modalId":"approveTransfer"');
  });

  it('Approve button is gated behind auth.canOperate', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain("auth.canOperate && xfer.is_current && xfer.status === 'requested'");
  });

  it('history cards expose a conditional Dispatch button for approved-status rows', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('"Dispatch"');
    expect(jsonStr).toContain("status === 'approved'");
    expect(jsonStr).toContain('"modalId":"dispatchTransfer"');
  });

  it('Dispatch button is gated behind auth.canOperate', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain("auth.canOperate && xfer.is_current && xfer.status === 'approved'");
  });

  it('history cards expose a conditional Receive button for in_transit-status rows', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain("status === 'in_transit'");
  });

  it('history Receive button is gated behind auth.canOperate', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain("auth.canOperate && xfer.is_current && xfer.status === 'in_transit'");
  });

  it('page defines approveTransfer, dispatchTransfer, and receiveTransfer lifecycle modals', () => {
    expect(transferManagementPage.modals).toHaveProperty('approveTransfer');
    expect(transferManagementPage.modals).toHaveProperty('dispatchTransfer');
    expect(transferManagementPage.modals).toHaveProperty('receiveTransfer');
  });

  it('lifecycle modals call rental_upsert_entity_current_state with the correct target status', () => {
    const jsonStr = JSON.stringify(transferManagementPage.modals);
    expect(jsonStr).toContain('rental_upsert_entity_current_state');
    expect(jsonStr).toContain('"status":"approved"');
    expect(jsonStr).toContain('"status":"in_transit"');
    expect(jsonStr).toContain('"status":"received"');
  });

  it('lifecycle action buttons pass transfer entity context as modal props', () => {
    const jsonStr = JSON.stringify(transferManagementPage.layout);
    expect(jsonStr).toContain('"actionTransferEntityId":"{{xfer.transfer_entity_id}}"');
    expect(jsonStr).toContain('"actionAssetScope":"{{xfer.asset_scope}}"');
    expect(jsonStr).toContain('"actionOriginBranchId":"{{xfer.origin_branch_id}}"');
    expect(jsonStr).toContain('"actionDestinationBranchId":"{{xfer.destination_branch_id}}"');
  });

  it('in-transit datasource select now includes approved_by for context preservation', () => {
    const ds = transferManagementPage.dataSources.in_transit;
    expect(ds.select).toContain('approved_by');
  });
});
