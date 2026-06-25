import { describe, expect, it } from 'vitest';
import { buildCounterReviewCases } from '@/lib/counter-review';

describe('counter review logic', () => {
  it('detects account blockers and missing billing inputs', () => {
    const cases = buildCounterReviewCases({
      contracts: [{
        id: 'contract-1',
        created_at: '2026-06-12T10:00:00Z',
        entity_versions: [{ data: { contract_number: 'RC-1', status: 'active', customer_id: 'customer-1' } }],
      }],
      customerProfiles: [{
        entity_id: 'customer-1',
        name: 'Acme',
        balance: 10000,
        credit_limit: 5000,
        payment_issue_flag: 1,
        data: {},
      }],
      customerIssues: [{
        issue_entity_id: 'issue-1',
        customer_id: 'customer-1',
        issue_type: 'ap_hold',
        status: 'open',
      }],
    });

    expect(cases).toHaveLength(1);
    expect(cases[0].accountSignals.map((signal) => signal.title)).toEqual(
      expect.arrayContaining([
        'Missing billing account input',
        'AP-hold or payment blocker detected',
        'Credit-limit blocker surfaced',
      ]),
    );
  });

  it('routes return exceptions with downstream evidence', () => {
    const cases = buildCounterReviewCases({
      contracts: [{
        id: 'contract-1',
        created_at: '2026-06-12T10:00:00Z',
        entity_versions: [{ data: { contract_number: 'RC-1', status: 'closed', customer_id: 'customer-1', billing_account_id: 'billing-1' } }],
      }],
      customerProfiles: [{
        entity_id: 'customer-1',
        name: 'Acme',
        balance: 0,
        credit_limit: 5000,
        payment_issue_flag: 0,
        data: {},
      }],
      contractLines: [{
        entity_id: 'line-1',
        contract_id: 'contract-1',
        asset_id: 'asset-1',
        status: 'returned',
        actual_end: '2026-06-15',
        data: {
          condition_outcome: 'fail',
          return_notes: 'Missing chain and visible dent.',
          missing_attachments: ['chain'],
          resulting_asset_status: 'on_inspection_hold',
        },
      }],
    });

    expect(cases[0].returnSignals).toHaveLength(1);
    expect(cases[0].returnSignals[0].title).toBe('Route to service follow-up');
    expect(cases[0].returnSignals[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Missing attachments', value: 'chain' }),
      ]),
    );
  });

  it('surfaces invoice anomalies as draft-only review work', () => {
    const cases = buildCounterReviewCases({
      contracts: [{
        id: 'contract-1',
        created_at: '2026-06-12T10:00:00Z',
        entity_versions: [{ data: { contract_number: 'RC-1', status: 'closed', customer_id: 'customer-1', billing_account_id: 'billing-1' } }],
      }],
      customerProfiles: [{
        entity_id: 'customer-1',
        name: 'Acme',
        balance: 0,
        credit_limit: 5000,
        payment_issue_flag: 0,
        data: {},
      }],
      contractLines: [{
        entity_id: 'line-1',
        contract_id: 'contract-1',
        asset_id: 'asset-1',
        status: 'returned',
        actual_end: '2026-06-10',
        data: { condition_outcome: 'pass' },
      }],
      invoices: [{
        id: 'invoice-1',
        created_at: '2026-06-13T09:00:00Z',
        entity_versions: [{
          data: {
            invoice_number: 'INV-1',
            status: 'draft',
            contract_id: 'contract-1',
            customer_id: 'customer-1',
            billing_account_id: 'billing-1',
            billing_period_start: '2026-06-01',
            billing_period_end: '2026-06-20',
            subtotal: 100,
            tax: 10,
            total: 999,
            billing_exception_reason: 'Missing signed delivery ticket',
          },
        }],
      }],
    });

    expect(cases[0].invoiceSignals.map((signal) => signal.title)).toEqual(
      expect.arrayContaining([
        'Invoice total mismatch surfaced',
        'Existing billing anomaly requires review',
        'Billing extends past recorded return',
      ]),
    );
    const mismatchSignal = cases[0].invoiceSignals.find((signal) => signal.title === 'Invoice total mismatch surfaced');
    expect(mismatchSignal?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Subtotal', value: '$100' }),
        expect.objectContaining({ label: 'Tax', value: '$10' }),
        expect.objectContaining({ label: 'Total', value: '$999' }),
      ]),
    );
    expect(cases[0].invoiceSignals.every((signal) => signal.reviewMode === 'draft')).toBe(true);
  });

  it('preserves customer-history context behind outside-sales suggestions', () => {
    const cases = buildCounterReviewCases({
      contracts: [{
        id: 'contract-1',
        created_at: '2026-06-12T10:00:00Z',
        entity_versions: [{ data: { contract_number: 'RC-1', status: 'active', customer_id: 'customer-1', billing_account_id: 'billing-1' } }],
      }],
      customerProfiles: [{
        entity_id: 'customer-1',
        name: 'Acme',
        balance: 0,
        credit_limit: 5000,
        payment_issue_flag: 0,
        data: { last_interaction_summary: 'Asked about a new project phase.' },
      }],
      communicationTimeline: [{
        timeline_event_id: 'timeline-1',
        customer_id: 'customer-1',
        occurred_at: '2026-06-13T10:00:00Z',
        interaction_label: 'Customer call',
        summary: 'Discussed a multi-site rollout with outside sales follow-up requested.',
        linked_entity_id: 'contract-1',
        linked_entity_type: 'rental_contract',
      }],
    });

    expect(cases[0].salesSignals).toHaveLength(1);
    expect(cases[0].salesSignals[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Customer history', value: 'Discussed a multi-site rollout with outside sales follow-up requested.' }),
      ]),
    );
  });
});
