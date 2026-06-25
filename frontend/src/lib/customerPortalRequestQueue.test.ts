import { describe, expect, it } from 'vitest';
import { buildCustomerPortalRequestQueue } from '@/lib/customerPortalRequestQueue';

describe('buildCustomerPortalRequestQueue', () => {
  it('deduplicates by contract/line/request_type and keeps the latest signal', () => {
    const result = buildCustomerPortalRequestQueue({
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-001' } }],
        },
      ],
      lines: [
        {
          entity_id: 'line-1',
          asset_id: 'asset-1',
          data: { job_site_id: 'site-1' },
        },
      ],
      customerRequests: [
        {
          id: 'req-older',
          entity_versions: [{
            data: {
              source: 'portal_schedule',
              contract_id: 'contract-1',
              contract_line_id: 'line-1',
              request_type: 'off_rent_pickup',
              urgency: 'standard',
              reason: 'Older request',
              requested_at: '2026-06-10T10:00:00.000Z',
              latest_signal_at: '2026-06-10T10:00:00.000Z',
            },
          }],
        },
        {
          id: 'req-newer',
          entity_versions: [{
            data: {
              source: 'portal_schedule',
              contract_id: 'contract-1',
              contract_line_id: 'line-1',
              request_type: 'off_rent_pickup',
              urgency: 'high',
              reason: 'Newer request',
              requested_at: '2026-06-10T10:00:00.000Z',
              latest_signal_at: '2026-06-11T10:00:00.000Z',
            },
          }],
        },
      ],
    });

    expect(result.noOp).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'req-newer',
      title: 'Pickup / call-off review for RC-001',
    });
  });

  it('marks uncertain when evidence gaps are present', () => {
    const result = buildCustomerPortalRequestQueue({
      contracts: [{ id: 'contract-1', entity_versions: [{ data: { contract_number: 'RC-001' } }] }],
      customerRequests: [
        {
          id: 'req-1',
          entity_versions: [{
            data: {
              source: 'portal_schedule',
              contract_id: 'contract-1',
              contract_line_id: 'line-1',
              request_type: 'field_service',
              urgency: 'critical',
              reason: 'Hydraulic leak',
              evidence_gaps: ['supporting_photos_missing'],
            },
          }],
        },
      ],
    });

    expect(result.items[0].status).toBe('uncertain');
    expect(result.items[0].evidence.some((item) => item.label === 'Evidence gaps')).toBe(true);
  });
});
