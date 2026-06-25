import type { DataSourceDefinition } from '@/engine';

export const counterReviewDataSources: Record<string, DataSourceDefinition> = {
  contracts: {
    type: 'supabase',
    table: 'entities',
    select: 'id, created_at, entity_versions!inner(data, is_current)',
    filters: [
      { field: 'entity_type', op: 'eq', value: 'rental_contract' },
      { field: 'entity_versions.is_current', op: 'eq', value: true },
    ],
    order: [{ column: 'created_at', ascending: false }],
    limit: 25,
  },
  invoices: {
    type: 'supabase',
    table: 'entities',
    select: 'id, created_at, entity_versions!inner(data, is_current)',
    filters: [
      { field: 'entity_type', op: 'eq', value: 'invoice' },
      { field: 'entity_versions.is_current', op: 'eq', value: true },
    ],
    order: [{ column: 'created_at', ascending: false }],
    limit: 40,
  },
  customerProfiles: {
    type: 'supabase',
    table: 'crm_customer_profile_current',
    select: 'entity_id, name, tier, balance, credit_limit, avg_days_to_pay, payment_issue_flag, data',
    order: [{ column: 'name', ascending: true }],
    limit: 50,
  },
  customerIssues: {
    type: 'supabase',
    table: 'crm_customer_issue_current',
    select: 'issue_entity_id, customer_id, billing_account_id, issue_type, status, severity, resolution_notes, opened_at, data',
    order: [{ column: 'opened_at', ascending: false }],
    limit: 50,
  },
  communicationTimeline: {
    type: 'supabase',
    table: 'crm_customer_communication_timeline',
    select: 'timeline_event_id, customer_id, billing_account_id, occurred_at, interaction_type, interaction_label, summary, linked_entity_id, linked_entity_type',
    order: [{ column: 'occurred_at', ascending: false }],
    limit: 60,
  },
  contractLines: {
    type: 'supabase',
    table: 'v_rental_contract_line_current',
    select: 'entity_id, contract_id, asset_id, status, actual_start, actual_end, data',
    order: [{ column: 'actual_start', ascending: false }],
    limit: 100,
  },
};
