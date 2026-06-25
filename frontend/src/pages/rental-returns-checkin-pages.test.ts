import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import returnsCheckInPage from './rental-returns-checkin.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('returns/check-in page definitions', () => {
  it('queries checked-out contract lines from v_rental_contract_line_current', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      returnsCheckInPage.dataSources.checked_out_lines as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_rental_contract_line_current');
    expect(query.select).toHaveBeenCalledWith(
      'entity_id, version_id, version_number, status, contract_id, asset_id, category_id, rental_type, rate_type, rate_amount, actual_start, actual_end, data'
    );
    expect(query.eq).toHaveBeenCalledWith('status', 'checked_out');
    expect(query.order).toHaveBeenCalledWith('actual_start', { ascending: true });
  });

  it('queries inspection hold lines from v_rental_contract_line_current', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      returnsCheckInPage.dataSources.inspection_holds as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_rental_contract_line_current');
    expect(query.select).toHaveBeenCalledWith('entity_id, asset_id, contract_id, actual_end, data');
    expect(query.eq).toHaveBeenCalledWith('status', 'returned');
    expect(query.eq).toHaveBeenCalledWith('resulting_asset_status', 'on_inspection_hold');
    expect(query.order).toHaveBeenCalledWith('actual_end', { ascending: false });
  });

  it('defines check-in persistence payloads with durable line merge and fail hold status mapping', () => {
    const serializedPage = JSON.stringify(returnsCheckInPage);

    expect(serializedPage).toContain('mergeRecordFieldById(data.checked_out_lines, state.checkIn_line_id');
    expect(serializedPage).toContain("lookupRecordFieldById(data.checked_out_lines, state.checkIn_line_id, 'asset_id', 'entity_id')");
    expect(serializedPage).toContain("state.checkIn_condition_outcome === 'fail' ? 'on_inspection_hold' : 'available'");
    expect(serializedPage).toContain('/rental/inspection-comparison?contract_line_id={{line.entity_id}}&asset_id={{line.asset_id}}');
  });
});
