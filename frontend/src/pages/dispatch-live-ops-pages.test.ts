import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import dispatchLiveOpsPage from './dispatch-live-ops.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('dispatch live ops page definitions', () => {
  it('queries active routes from v_dispatch_route_live with full column set', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      dispatchLiveOpsPage.dataSources.active_routes as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_dispatch_route_live');
    expect(query.select).toHaveBeenCalledWith(
      'line_id, contract_id, asset_id, asset_name, asset_serial, line_status, assigned_driver, assigned_truck, departure_at, actual_start, actual_end, route_status, exception_state, branch_id, telemetry_position_status, eld_compliance_status, driver_log_status, telemetry_event_at, telemetry_sync_status, updated_at'
    );
    expect(query.order).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(100);
  });

  it('applies route_status ilike filter from state', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      dispatchLiveOpsPage.dataSources.active_routes as SupabaseDataSource,
      createExpressionContext({ state: { routeStatusFilter: 'in_transit', exceptionFilter: '%', driverFilter: '', truckFilter: '', branchFilter: '' } })
    );

    expect(query.ilike).toHaveBeenCalledWith('route_status', 'in_transit');
  });

  it('applies exception_state ilike filter from state', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      dispatchLiveOpsPage.dataSources.active_routes as SupabaseDataSource,
      createExpressionContext({ state: { routeStatusFilter: '%', exceptionFilter: 'missing_driver', driverFilter: '', truckFilter: '', branchFilter: '' } })
    );

    expect(query.ilike).toHaveBeenCalledWith('exception_state', 'missing_driver');
  });

  it('queries efficiency summary from v_transport_efficiency_summary', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      dispatchLiveOpsPage.dataSources.efficiency_summary as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_transport_efficiency_summary');
    expect(query.select).toHaveBeenCalledWith(
      'total_routes, loaded_routes, empty_routes, load_utilization_pct, active_routes, completed_routes, missing_driver_count, overdue_count, eld_warning_count, eld_violation_count, stale_position_count'
    );
  });

  it('page has the expected five filter state keys', () => {
    const stateKeys = Object.keys(dispatchLiveOpsPage.state);
    expect(stateKeys).toContain('driverFilter');
    expect(stateKeys).toContain('truckFilter');
    expect(stateKeys).toContain('branchFilter');
    expect(stateKeys).toContain('routeStatusFilter');
    expect(stateKeys).toContain('exceptionFilter');
  });

  it('active_routes data source has a 15-second refetch interval', () => {
    expect(dispatchLiveOpsPage.dataSources.active_routes.refetchInterval).toBe(15000);
  });

  it('efficiency_summary data source has a 15-second refetch interval', () => {
    expect(dispatchLiveOpsPage.dataSources.efficiency_summary.refetchInterval).toBe(15000);
  });

  it('efficiency summary card defines a non-blank empty state', () => {
    const summaryCard = dispatchLiveOpsPage.layout.children[1] as unknown as { children: Array<{ children?: Array<{ type?: string; if?: string; props?: { children?: string } }> }> };
    const summaryStack = summaryCard.children[0] as unknown as { children: Array<{ type?: string; if?: string; props?: { children?: string } }> };
    const emptyStateText = summaryStack.children.find(
      (child: { type?: string; if?: string }) =>
        child.type === 'Text' &&
        child.if === '{{!isLoading.efficiency_summary && !errors.efficiency_summary && !data.efficiency_summary.length}}'
    );

    expect(emptyStateText).toBeTruthy();
    expect(emptyStateText?.props?.children).toContain('No active routes in the current window');
    expect(emptyStateText?.props?.children).toContain('Adjust filters or wait for route assignments');
  });

  it('route_status filter options include all expected statuses', () => {
    const filterCard = dispatchLiveOpsPage.layout.children[2] as unknown as { children: Array<{ children: Array<{ props: { options: Array<{ value: string }> } }> }> };
    const grid = filterCard.children[0] as unknown as { children: Array<{ props: { options: Array<{ value: string }> } }> };
    const routeStatusSelect = grid.children[0];
    const optionValues = routeStatusSelect.props.options.map((o: { value: string }) => o.value);
    expect(optionValues).toContain('%');
    expect(optionValues).toContain('pending_departure');
    expect(optionValues).toContain('in_transit');
    expect(optionValues).toContain('delivered');
  });

  it('exception filter options include missing_driver and overdue', () => {
    const filterCard = dispatchLiveOpsPage.layout.children[2] as unknown as { children: Array<{ children: Array<{ props: { options: Array<{ value: string }> } }> }> };
    const grid = filterCard.children[0] as unknown as { children: Array<{ props: { options: Array<{ value: string }> } }> };
    const exceptionSelect = grid.children[1];
    const optionValues = exceptionSelect.props.options.map((o: { value: string }) => o.value);
    expect(optionValues).toContain('missing_driver');
    expect(optionValues).toContain('overdue');
  });
});
