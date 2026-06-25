import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import projectProposalWorkbenchPage from './project-proposal-workbench.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('project-proposal-workbench page definitions', () => {
  it('queries v_project_proposal_account_context for account context', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      projectProposalWorkbenchPage.dataSources.account_context as SupabaseDataSource,
      createExpressionContext({ state: { customerFilter: '' } })
    );

    expect(client.from).toHaveBeenCalledWith('v_project_proposal_account_context');
    expect(query.select).toHaveBeenCalledWith(
      'entity_id, name, customer_type, tier, industry, balance, credit_limit, avg_days_to_pay, payment_issue_flag, primary_contact_name, primary_contact_email, rental_order_count, last_order_at, data_freshness_at'
    );
  });

  it('applies customer name ilike filter on account_context', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      projectProposalWorkbenchPage.dataSources.account_context as SupabaseDataSource,
      createExpressionContext({ state: { customerFilter: 'Acme' } })
    );

    expect(query.ilike).toHaveBeenCalledWith('name', 'Acme');
  });

  it('queries v_project_proposal_pricing_history for pricing history', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      projectProposalWorkbenchPage.dataSources.pricing_history as SupabaseDataSource,
      createExpressionContext({ state: { categoryFilter: '' } })
    );

    expect(client.from).toHaveBeenCalledWith('v_project_proposal_pricing_history');
    expect(query.select).toHaveBeenCalledWith(
      'category_id, category_name, rate_type, min_rate, max_rate, avg_rate, sample_count, last_seen_at, is_stale'
    );
  });

  it('applies category name ilike filter on pricing_history', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      projectProposalWorkbenchPage.dataSources.pricing_history as SupabaseDataSource,
      createExpressionContext({ state: { categoryFilter: 'Excavator' } })
    );

    expect(query.ilike).toHaveBeenCalledWith('category_name', 'Excavator');
  });

  it('queries rental_asset_availability_current for branch availability', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      projectProposalWorkbenchPage.dataSources.availability as SupabaseDataSource,
      createExpressionContext({ state: { branchFilter: '' } })
    );

    expect(client.from).toHaveBeenCalledWith('rental_asset_availability_current');
    expect(query.select).toHaveBeenCalledWith(
      'branch_id, branch_name, asset_category_id, asset_category_name, total_assets, available_assets, unavailable_assets'
    );
  });

  it('applies branch name ilike filter on availability', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      projectProposalWorkbenchPage.dataSources.availability as SupabaseDataSource,
      createExpressionContext({ state: { branchFilter: 'North' } })
    );

    expect(query.ilike).toHaveBeenCalledWith('branch_name', 'North');
  });

  it('queries ops_findings_view for pending rate approvals filtered to project-proposal-workbench', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      projectProposalWorkbenchPage.dataSources.pending_approvals as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'project-proposal-workbench');
    expect(query.eq).toHaveBeenCalledWith('status', 'pending_approval');
  });

  it('account_context is ordered by name ascending', () => {
    const order = projectProposalWorkbenchPage.dataSources.account_context.order;
    expect(order).toEqual([{ column: 'name', ascending: true }]);
  });

  it('pricing_history is ordered by sample_count descending then category_name ascending', () => {
    const order = projectProposalWorkbenchPage.dataSources.pricing_history.order;
    expect(order).toEqual([
      { column: 'sample_count', ascending: false },
      { column: 'category_name', ascending: true },
    ]);
  });

  it('pending_approvals are ordered by created_at descending', () => {
    const order = projectProposalWorkbenchPage.dataSources.pending_approvals.order;
    expect(order).toEqual([{ column: 'created_at', ascending: false }]);
  });

  it('page layout surfaces stale pricing warning', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Stale pricing evidence');
    expect(serialized).toContain('is_stale');
  });

  it('page layout surfaces stale account data warning', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Stale account data');
    expect(serialized).toContain('data_freshness_at');
  });

  it('page layout includes unavailable data error alerts for all four sources', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Unable to load account context');
    expect(serialized).toContain('Unable to load pricing history');
    expect(serialized).toContain('Branch availability data unavailable');
    expect(serialized).toContain('Unable to load approval cases');
  });

  it('page layout includes assist-only callout preventing auto-send', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Assist only');
    expect(serialized).toContain('no auto-send or price commit');
    expect(serialized).toContain('explicit rep review and approval');
  });

  it('page layout includes approval-required callout gating customer-facing materials', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Approval required before customer-facing materials');
    expect(serialized).toContain('approved by an authorized approver');
  });

  it('page layout links pending approvals to ops findings detail for review', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('/ops/findings/{{approval.id}}');
    expect(serialized).toContain('Review & decide approval');
  });

  it('page layout links to CRM profile for account drill-down', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('/crm/customers/{{customer.entity_id}}');
    expect(serialized).toContain('Open CRM profile');
  });

  it('page layout links to Quote Builder for drafting lines', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('/rental/quoting');
    expect(serialized).toContain('Open Quote Builder');
  });

  it('page layout links availability rows to availability detail', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('/rental/availability');
    expect(serialized).toContain('Full details');
  });

  it('page layout threads outside-sales-representative operating-model tags', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('outside-sales-representative:t3');
    expect(serialized).toContain('outside-sales-representative:t5');
  });

  it('page state defaults all filters to wildcard percent', () => {
    expect(projectProposalWorkbenchPage.state.customerFilter).toBe('%');
    expect(projectProposalWorkbenchPage.state.categoryFilter).toBe('%');
    expect(projectProposalWorkbenchPage.state.branchFilter).toBe('%');
  });

  it('availability data source refetches every 30 seconds', () => {
    expect(projectProposalWorkbenchPage.dataSources.availability.refetchInterval).toBe(30000);
  });

  it('pending_approvals data source refetches every 15 seconds', () => {
    expect(projectProposalWorkbenchPage.dataSources.pending_approvals.refetchInterval).toBe(15000);
  });

  it('pricing_history data source includes is_stale field for gap surfacing', () => {
    const select = projectProposalWorkbenchPage.dataSources.pricing_history.select;
    expect(select).toContain('is_stale');
  });

  // ── Submission path behavioral tests ──────────────────────────────────────
  // These tests will fail if the submit-for-approval flow is removed or broken.

  it('page layout contains a Button with Submit for Approval label', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Submit for Approval');
  });

  it('page layout wires Submit button to staff_submit_project_proposal_for_approval RPC', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('"operation":"rpc"');
    expect(serialized).toContain('"function":"staff_submit_project_proposal_for_approval"');
  });

  it('RPC action carries required proposal parameters', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('p_customer_id');
    expect(serialized).toContain('p_customer_name');
    expect(serialized).toContain('p_branch_id');
    expect(serialized).toContain('p_branch_name');
    expect(serialized).toContain('p_term_days');
    expect(serialized).toContain('p_notes');
  });

  it('RPC action sends p_categories bound to pricing_history data source', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    // Exact fragment — fails if p_categories wiring is removed or the binding changes
    expect(serialized).toContain('"p_categories":"{{data.pricing_history}}"');
  });

  it('RPC action sends p_proposed_rates bound to availability data source', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    // Exact fragment — fails if p_proposed_rates wiring is removed or the binding changes
    expect(serialized).toContain('"p_proposed_rates":"{{data.availability}}"');
  });

  it('RPC action sends p_branch_name bound to submit_branch_name state', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('"p_branch_name":"{{state.submit_branch_name}}"');
  });

  it('Submit onSuccess clears submit_branch_name field', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('"action":"setState","key":"submit_branch_name","value":""');
  });

  it('page state initializes submit_branch_name to empty string', () => {
    expect(projectProposalWorkbenchPage.state.submit_branch_name).toBe('');
  });

  it('Submit onSuccess refetches pending_approvals data source', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    // The exact JSON fragment that only matches if the refetch is in the onSuccess sequence
    expect(serialized).toContain('"action":"refetch","source":"pending_approvals"');
  });

  it('Submit onSuccess sets submitStatus to success', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    // Must appear inside the onSuccess sequence of the RPC action
    expect(serialized).toContain('"action":"setState","key":"submitStatus","value":"success"');
  });

  it('Submit onError sets submitStatus to error', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    // Must be the onError handler of the submit RPC action
    expect(serialized).toContain('"onError":{"action":"setState","key":"submitStatus","value":"error"}');
  });

  it('page state initializes submit form fields to empty defaults', () => {
    expect(projectProposalWorkbenchPage.state.submit_customer_id).toBe('');
    expect(projectProposalWorkbenchPage.state.submit_customer_name).toBe('');
    expect(projectProposalWorkbenchPage.state.submit_branch_id).toBe('');
    expect(projectProposalWorkbenchPage.state.submit_notes).toBe('');
    expect(projectProposalWorkbenchPage.state.submitStatus).toBe('');
  });

  it('page state defaults submit_term_days to 30', () => {
    expect(projectProposalWorkbenchPage.state.submit_term_days).toBe('30');
  });

  it('page layout includes Submit for Internal Approval section heading', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Submit for Internal Approval');
  });

  it('page layout shows success alert when submitStatus is success', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Approval case submitted');
    expect(serialized).toContain("state.submitStatus === 'success'");
  });

  it('page layout shows error alert when submitStatus is error', () => {
    const serialized = JSON.stringify(projectProposalWorkbenchPage.layout);
    expect(serialized).toContain('Submission failed');
    expect(serialized).toContain("state.submitStatus === 'error'");
  });
});