import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext, evaluateExpression } from '@/engine/ExpressionEvaluator';
import opsFactoryDashboardPage from './ops-factory-dashboard.json';
import opsFindingsQueuePage from './ops-findings-queue.json';
import opsCollectionsQueuePage from './ops-collections-queue.json';
import opsRevenueRecognitionPage from './ops-revenue-recognition.json';
import opsFleetAuditsPage from './ops-fleet-audits.json';
import opsFindingDetailPage from './ops-finding-detail.json';
import opsAuditTrailPage from './ops-audit-trail.json';
import opsCreditReviewQueuePage from './ops-credit-review-queue.json';
import opsLienDeadlinesPage from './ops-lien-deadlines.json';
import opsAccountHealthQueuePage from './ops-account-health-queue.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('ops page definitions', () => {
  it('queries agent fleet and KPI views for dashboard cards', () => {
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
      opsFactoryDashboardPage.dataSources.agent_status as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_agent_status_view');
    expect(query.select).toHaveBeenCalledWith(
      'tenant_id, agent_key, enabled, last_run_id, last_run_started_at, last_run_finished_at, last_run_status, next_run_at, total_runs, succeeded_runs, failed_runs, pending_findings, has_pending_badge, identified_delta'
    );
    expect(query.order).toHaveBeenCalledWith('pending_findings', { ascending: false });
  });

  it('applies findings filters and default $ delta sort descending', () => {
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
      opsFindingsQueuePage.dataSources.findings as SupabaseDataSource,
      createExpressionContext({
        state: {
          workflowFilter: 'revrec-analyst',
          severityFilter: 'high',
          statusFilter: 'pending_approval',
          branchFilter: '%north%',
          customerFilter: '%acme%',
        },
      })
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.ilike).toHaveBeenCalledWith('agent_key', 'revrec-analyst');
    expect(query.ilike).toHaveBeenCalledWith('severity', 'high');
    expect(query.ilike).toHaveBeenCalledWith('status', 'pending_approval');
    expect(query.order).toHaveBeenCalledWith('delta', { ascending: false });
  });

  it('includes the damage assistant in workflow filter options', () => {
    const workflowOptions = (opsFindingsQueuePage.layout.children[1] as { children: Array<{ props: { options: Array<{ value: string; label: string }> } }> }).children[0]?.props.options ?? [];

    expect(workflowOptions).toContainEqual({
      value: 'credit-analyst',
      label: 'AR Collections',
    });
    expect(workflowOptions).toContainEqual({
      value: 'damage-returns-charge-assistant',
      label: 'Damage & Returns Charges',
    });
  });

  it('pins the collections queue to the credit analyst workflow', () => {
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
      opsCollectionsQueuePage.dataSources.findings as SupabaseDataSource,
      createExpressionContext()
    );

    expect(query.eq).toHaveBeenCalledWith('agent_key', 'credit-analyst');
    expect(query.order).toHaveBeenCalledWith('delta', { ascending: false });
  });

  it('pins revenue and fleet views to their business workflow filters', () => {
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
      opsRevenueRecognitionPage.dataSources.findings as SupabaseDataSource,
      createExpressionContext()
    );
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'revrec-analyst');

    query.eq.mockClear();

    buildSupabaseQuery(
      client as never,
      opsFleetAuditsPage.dataSources.findings as SupabaseDataSource,
      createExpressionContext()
    );
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'fleet-auditor');
  });

  it('resolves detail and audit filters from route params', () => {
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
      opsFindingDetailPage.dataSources.finding as SupabaseDataSource,
      createExpressionContext({ params: { findingId: 'finding-123' } })
    );
    expect(query.eq).toHaveBeenCalledWith('id', 'finding-123');

    query.eq.mockClear();

    buildSupabaseQuery(
      client as never,
      opsAuditTrailPage.dataSources.audit as SupabaseDataSource,
      createExpressionContext({ params: { entityId: 'entity-456' } })
    );
    expect(query.eq).toHaveBeenCalledWith('entity_id', 'entity-456');

    query.eq.mockClear();

    buildSupabaseQuery(
      client as never,
      opsAuditTrailPage.dataSources.finding_context as SupabaseDataSource,
      createExpressionContext({ params: { entityId: 'entity-456' } })
    );
    expect(query.eq).toHaveBeenCalledWith('contract_id', 'entity-456');
  });

  it('formats dollar values as currency and gates approve/reject by canOperate', () => {
    const currency = evaluateExpression(
      '{{formatCurrency(data.finding.delta || 0)}}',
      createExpressionContext({ data: { finding: { delta: 3480.5 } } })
    );

    expect(currency).toBe('$3,480.50');

    const canOperate = evaluateExpression(
      '{{state.canOperate}}',
      createExpressionContext({ state: { canOperate: false } })
    );

    expect(canOperate).toBe(false);

    const agentLabel = evaluateExpression(
      "{{formatOpsAgentLabel('revrec-analyst')}}",
      createExpressionContext()
    );

    expect(agentLabel).toBe('Revenue Recognition');

    const damageAgentLabel = evaluateExpression(
      "{{formatOpsAgentLabel('damage-returns-charge-assistant')}}",
      createExpressionContext()
    );

    expect(damageAgentLabel).toBe('Damage & Returns Charges');

    const quoteLabel = evaluateExpression(
      "{{formatOpsAgentLabel('quote-to-order-copilot')}}",
      createExpressionContext()
    );

    expect(quoteLabel).toBe('Quote-to-Order Copilot');

    const collectionsLabel = evaluateExpression(
      "{{formatOpsAgentLabel('credit-analyst')}}",
      createExpressionContext()
    );

    expect(collectionsLabel).toBe('AR Collections');

    const workflowLink = evaluateExpression(
      "{{getOpsWorkflowRoute('fleet-auditor')}}",
      createExpressionContext()
    );

    expect(workflowLink).toBe('/ops/fleet-audits?status=pending_approval');

    const damageWorkflowLink = evaluateExpression(
      "{{getOpsWorkflowRoute('damage-returns-charge-assistant')}}",
      createExpressionContext()
    );

    expect(damageWorkflowLink).toBe('/ops/findings?workflow=damage-returns-charge-assistant');

    const collectionsWorkflowLink = evaluateExpression(
      "{{getOpsWorkflowRoute('credit-analyst')}}",
      createExpressionContext()
    );

    expect(collectionsWorkflowLink).toBe('/ops/collections?status=pending_approval');
  });

  it('offers the quote-to-order copilot in the findings workflow filter', () => {
    const workflowSelect = (opsFindingsQueuePage.layout.children[1] as { children: Array<{ props: { options: Array<{ value: string; label: string }> } }> }).children[0];
    expect(workflowSelect?.props.options).toContainEqual({
      value: 'quote-to-order-copilot',
      label: 'Quote-to-Order Copilot',
    });
  });

  it('humanizes known finding_type keys via formatFindingType', () => {
    expect(
      evaluateExpression("{{formatFindingType('collections_priority')}}", createExpressionContext())
    ).toBe('Collections priority');

    expect(
      evaluateExpression("{{formatFindingType('billing_past_return')}}", createExpressionContext())
    ).toBe('Billing past return');

    expect(
      evaluateExpression("{{formatFindingType('unbilled_on_rent')}}", createExpressionContext())
    ).toBe('Unbilled while on rent');

    expect(
      evaluateExpression("{{formatFindingType('over_billed')}}", createExpressionContext())
    ).toBe('Over-billed');

    expect(
      evaluateExpression("{{formatFindingType('some_unknown_type')}}", createExpressionContext())
    ).toBe('Some unknown type');
  });

  it('humanizes finding status labels via formatFindingStatus', () => {
    expect(
      evaluateExpression("{{formatFindingStatus('pending_approval')}}", createExpressionContext())
    ).toBe('Pending approval');

    expect(
      evaluateExpression("{{formatFindingStatus('approved')}}", createExpressionContext())
    ).toBe('Approved');

    expect(
      evaluateExpression("{{formatFindingStatus('rejected')}}", createExpressionContext())
    ).toBe('Rejected');

    expect(
      evaluateExpression("{{formatFindingStatus('informational')}}", createExpressionContext())
    ).toBe('Informational');
  });

  it('revenue recognition page includes a kpis data source from ops_finding_kpis', () => {
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
      opsRevenueRecognitionPage.dataSources.kpis as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_finding_kpis');
    expect(query.select).toHaveBeenCalledWith(
      'tenant_id, pending_count, recoverable_delta, approved_this_cycle, findings_last_24h'
    );
  });

  it('revenue recognition KPI strip uses StatCard components', () => {
    const layout = opsRevenueRecognitionPage.layout;
    const kpiStrip = layout.children.find(
      (c: { if?: string }) => c.if && String(c.if).includes('kpis')
    );
    expect(kpiStrip).toBeDefined();
    const statCards = (kpiStrip as { children?: Array<{ type: string }> })?.children ?? [];
    expect(statCards.every((c) => c.type === 'StatCard')).toBe(true);
    expect(statCards.length).toBe(4);
  });

  it('revenue recognition finding cards use semantic Badge status prop not raw variant', () => {
    const layout = opsRevenueRecognitionPage.layout;
    const findingsStack = layout.children.find(
      (c: { if?: string }) => c.if && String(c.if).includes('findings.length > 0')
    );
    expect(findingsStack).toBeDefined();
    const card = (findingsStack as { children?: Array<{ children?: Array<{ children?: unknown[] }> }> })?.children?.[0];
    const innerStack = (card as { children?: Array<{ children?: Array<{ children?: Array<{ props?: Record<string, unknown> }> }> }> })?.children?.[0]?.children?.[1]?.children;
    const badgeNode = (innerStack as Array<{ type?: string; props?: Record<string, unknown> }> | undefined)?.find((n) => n.type === 'Badge');
    expect(badgeNode).toBeDefined();
    expect((badgeNode as { props?: Record<string, unknown> })?.props).toHaveProperty('status');
    expect((badgeNode as { props?: Record<string, unknown> })?.props).not.toHaveProperty('variant');
  });

  it('revenue recognition status filter options are humanized', () => {
    const filterGrid = opsRevenueRecognitionPage.layout.children.find(
      (c: { type?: string; if?: string }) => c.type === 'Grid' && !c.if
    );
    const statusSelect = (filterGrid as { children?: Array<{ props?: { label?: string; options?: Array<{ value: string; label: string }> } }> })?.children?.find(
      (c) => c.props?.label === 'Status'
    );
    expect(statusSelect?.props?.options).toContainEqual({
      value: 'pending_approval',
      label: 'Pending approval',
    });
    expect(statusSelect?.props?.options).toContainEqual({
      value: 'approved',
      label: 'Approved',
    });
    expect(statusSelect?.props?.options).not.toContainEqual(
      expect.objectContaining({ label: 'pending_approval' })
    );
  });

  it('revenue recognition finding cards do not render raw finding_type keys', () => {
    const layout = opsRevenueRecognitionPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('formatFindingType');
    expect(jsonStr).not.toContain('"children": "{{finding.finding_type}}"');
    expect(jsonStr).not.toContain('"children": "{{data.finding.finding_type}}"');
  });

  it('finding detail hero uses humanized finding type and formatDateTime', () => {
    const layout = opsFindingDetailPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('formatFindingType');
    expect(jsonStr).toContain('formatDateTime');
    expect(jsonStr).not.toContain('"children": "{{data.finding.finding_type}}"');
  });

  it('finding detail has a proposed-action callout with accent border styling', () => {
    const layout = opsFindingDetailPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('border-l-primary');
    expect(jsonStr).toContain('Proposed action');
  });

  it('finding detail evidence uses actual evidence label fields not literal placeholder', () => {
    const layout = opsFindingDetailPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('evidence.label');
    expect(jsonStr).not.toContain('"Evidence item"');
  });

  it('finding detail formats confidence as percent', () => {
    const layout = opsFindingDetailPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('formatPercent');
    expect(jsonStr).toContain('confident');
  });

  it('finding detail renders a severity · status summary line for queue context durability', () => {
    const layout = opsFindingDetailPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('data.finding.severity');
    expect(jsonStr).toContain('formatFindingStatus');
    expect(jsonStr).toContain('findingStatusOverride');
    // The combined text line must contain the mid-dot separator used by the E2E assertion
    expect(jsonStr).toContain('·');
  });

  it('finding detail severity·status line uses findingStatusOverride for optimistic status updates', () => {
    const layout = opsFindingDetailPage.layout;
    const jsonStr = JSON.stringify(layout);
    // Ensure the combined line reads the optimistic override before falling back to real status
    expect(jsonStr).toContain('state.findingStatusOverride || data.finding.status');
  });

  it('audit trail page includes finding context and human-readable summaries', () => {
    const jsonStr = JSON.stringify(opsAuditTrailPage.layout);
    expect(jsonStr).toContain('Finding context');
    expect(jsonStr).toContain('Summary:');
    expect(jsonStr).toContain('formatOpsAuditSummary');
  });

  it('finding detail read-only alert is a top-level sibling of the data block not nested inside it', () => {
    const children = opsFindingDetailPage.layout.children as Array<{ type: string; if?: string; props?: Record<string, unknown> }>;
    const readOnlyAlertIndex = children.findIndex(
      (c) => c.type === 'Alert' && c.if === '{{!auth.canOperate}}'
    );
    const dataBlockIndex = children.findIndex(
      (c) => c.if === '{{!errors.finding && data.finding}}'
    );
    expect(readOnlyAlertIndex, 'read-only alert must exist as a top-level layout child').toBeGreaterThanOrEqual(0);
    expect(dataBlockIndex, 'data-conditional block must exist as a top-level layout child').toBeGreaterThanOrEqual(0);
    // Alert must appear before the data block so it is visible even before data arrives
    expect(readOnlyAlertIndex).toBeLessThan(dataBlockIndex);
    const alert = children[readOnlyAlertIndex];
    expect((alert.props as { title?: string })?.title).toBe('Read-only');
    expect((alert.props as { description?: string })?.description).toBe(
      'You can review this finding, but only operators can approve or reject.'
    );
  });

  it('finding detail loading message uses default contrast-safe text instead of muted text', () => {
    const children = opsFindingDetailPage.layout.children as Array<{ type: string; if?: string; props?: Record<string, unknown> }>;
    const loadingText = children.find(
      (c) => c.type === 'Text' && c.if === '{{isLoading.finding}}'
    );

    expect(loadingText, 'loading text must exist').toBeDefined();
    expect((loadingText?.props as { variant?: string })?.variant).toBe('default');
  });

  it('finding detail read-only badge inside data block is distinct from the top-level alert', () => {
    // The Badge with status:"read_only" sits inside the data-conditional hero row
    // and is therefore only rendered after finding data has loaded.
    // The top-level Alert uses !auth.canOperate independently of data state.
    const layoutJson = JSON.stringify(opsFindingDetailPage.layout);
    expect(layoutJson).toContain('"status":"read_only"');

    // The top-level alert condition must not reference data or errors
    const children = opsFindingDetailPage.layout.children as Array<{ type: string; if?: string }>;
    const readOnlyAlert = children.find((c) => c.type === 'Alert' && c.if === '{{!auth.canOperate}}');
    expect(readOnlyAlert, 'top-level read-only Alert must exist').toBeDefined();
    // Its if condition must be solely auth-based — no data or error guard
    expect(readOnlyAlert?.if).not.toContain('data.');
    expect(readOnlyAlert?.if).not.toContain('errors.');
    expect(readOnlyAlert?.if).not.toContain('isLoading.');
  });

  it('collections queue badge uses formatFindingStatus not raw status token', () => {
    const jsonStr = JSON.stringify(opsCollectionsQueuePage.layout);
    expect(jsonStr).toContain('formatFindingStatus');
    expect(jsonStr).not.toContain('"children":"{{finding.status}}"');
  });

  it('collections queue filter option labels are human-readable not raw tokens', () => {
    const jsonStr = JSON.stringify(opsCollectionsQueuePage.layout);
    expect(jsonStr).not.toContain('"label":"pending_approval"');
    expect(jsonStr).not.toContain('"label":"approved"');
    expect(jsonStr).not.toContain('"label":"rejected"');
    expect(jsonStr).not.toContain('"label":"informational"');
    expect(jsonStr).not.toContain('"label":"high"');
    expect(jsonStr).not.toContain('"label":"medium"');
    expect(jsonStr).not.toContain('"label":"low"');
    expect(jsonStr).toContain('"label":"Pending approval"');
    expect(jsonStr).toContain('"label":"High"');
  });

  it('collections queue escalation uses formatEscalationStage not raw routine_follow_up token', () => {
    const jsonStr = JSON.stringify(opsCollectionsQueuePage.layout);
    expect(jsonStr).not.toContain('routine_follow_up');
    expect(jsonStr).toContain('formatEscalationStage');
  });

  it('collections queue "Open finding" link passes source=collections and return filter context', () => {
    const jsonStr = JSON.stringify(opsCollectionsQueuePage.layout);
    expect(jsonStr).toContain('"source":"collections"');
    expect(jsonStr).toContain('returnSeverity');
    expect(jsonStr).toContain('returnStatus');
  });

  it('formatEscalationStage humanizes known escalation stage tokens', () => {
    expect(
      evaluateExpression("{{formatEscalationStage('routine_follow_up')}}", createExpressionContext())
    ).toBe('Routine follow-up');

    expect(
      evaluateExpression("{{formatEscalationStage('approaching_formal_escalation')}}", createExpressionContext())
    ).toBe('Approaching formal escalation');

    expect(
      evaluateExpression("{{formatEscalationStage('formal_notice')}}", createExpressionContext())
    ).toBe('Formal notice');

    expect(
      evaluateExpression("{{formatEscalationStage('')}}", createExpressionContext())
    ).toBe('Routine follow-up');

    // Unknown tokens fall back to sentence-case (consistent with formatFindingStatus)
    expect(
      evaluateExpression("{{formatEscalationStage('pending_legal_review')}}", createExpressionContext())
    ).toBe('Pending legal review');
  });

  it('finding detail back links: collections gets its own link; fleet-audits fallback excludes collections', () => {
    type BackLinkChild = { type: string; if?: string; props?: { to?: string; children?: string } };
    const children = opsFindingDetailPage.layout.children as BackLinkChild[];

    const collectionsBackLink = children.find(
      (c) => c.type === 'Link' && c.if === "{{state.queueSource === 'collections'}}"
    );
    expect(collectionsBackLink, '"Back to AR Collections" back link must exist').toBeDefined();
    expect(collectionsBackLink?.props?.to).toBe('/ops/collections');
    expect(collectionsBackLink?.props?.children).toContain('Back to AR Collections');

    const fleetAuditsLink = children.find(
      (c) => c.type === 'Link' && c.props?.to === '/ops/fleet-audits'
    );
    expect(fleetAuditsLink, 'Fleet Audits back link must exist').toBeDefined();
    expect(fleetAuditsLink?.if, 'Fleet Audits back link must exclude collections source').toContain('collections');
    expect(fleetAuditsLink?.if).not.toBe("{{state.queueSource !== 'revenue-recognition'}}");
  });

  it('finding detail shows escalation stage for credit-analyst findings', () => {
    const jsonStr = JSON.stringify(opsFindingDetailPage.layout);
    expect(jsonStr).toContain('formatEscalationStage');
    expect(jsonStr).toContain('escalation_stage');
  });

  it('credit review queue pins to credit-lien-control agent key and credit_application_review finding type', () => {
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
      opsCreditReviewQueuePage.dataSources.findings as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'credit-lien-control');
    expect(query.eq).toHaveBeenCalledWith('finding_type', 'credit_application_review');
    expect(query.order).toHaveBeenCalledWith('delta', { ascending: false });
  });

  it('lien deadlines queue pins to credit-lien-control agent key and lien_deadline finding type', () => {
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
      opsLienDeadlinesPage.dataSources.deadlines as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'credit-lien-control');
    expect(query.eq).toHaveBeenCalledWith('finding_type', 'lien_deadline');
  });

  it('lien waivers queue pins to credit-lien-control agent key and lien_waiver finding type', () => {
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
      opsLienDeadlinesPage.dataSources.waivers as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'credit-lien-control');
    expect(query.eq).toHaveBeenCalledWith('finding_type', 'lien_waiver');
  });

  it('getOpsWorkflowRoute routes credit-lien-control to /ops/credit-review', () => {
    const route = evaluateExpression(
      "{{getOpsWorkflowRoute('credit-lien-control')}}",
      createExpressionContext()
    );
    expect(route).toBe('/ops/credit-review?status=pending_approval');
  });

  it('formatOpsAgentLabel humanizes credit-lien-control to its display label', () => {
    const label = evaluateExpression(
      "{{formatOpsAgentLabel('credit-lien-control')}}",
      createExpressionContext()
    );
    expect(label).toBe('Credit Review & Lien Control');
  });

  it('formatFindingType humanizes credit/lien finding type keys', () => {
    expect(
      evaluateExpression("{{formatFindingType('credit_application_review')}}", createExpressionContext())
    ).toBe('Credit application review');

    expect(
      evaluateExpression("{{formatFindingType('lien_deadline')}}", createExpressionContext())
    ).toBe('Lien deadline');

    expect(
      evaluateExpression("{{formatFindingType('lien_waiver')}}", createExpressionContext())
    ).toBe('Lien waiver');
  });

  it('formatLienUrgency humanizes all known urgency keys', () => {
    expect(
      evaluateExpression("{{formatLienUrgency('overdue')}}", createExpressionContext())
    ).toBe('Overdue');

    expect(
      evaluateExpression("{{formatLienUrgency('critical')}}", createExpressionContext())
    ).toBe('Critical (≤5 days)');

    expect(
      evaluateExpression("{{formatLienUrgency('warning')}}", createExpressionContext())
    ).toBe('Warning (≤14 days)');

    expect(
      evaluateExpression("{{formatLienUrgency('ok')}}", createExpressionContext())
    ).toBe('On track');

    expect(
      evaluateExpression("{{formatLienUrgency('not_required')}}", createExpressionContext())
    ).toBe('Not required');

    expect(
      evaluateExpression("{{formatLienUrgency('unknown_jurisdiction')}}", createExpressionContext())
    ).toBe('Unknown jurisdiction — manual review');

    expect(
      evaluateExpression("{{formatLienUrgency('')}}", createExpressionContext())
    ).toBe('Unknown');
  });

  it('lien deadlines page uses formatLienUrgency and formatFindingType in deadline cards', () => {
    const jsonStr = JSON.stringify(opsLienDeadlinesPage.layout);
    expect(jsonStr).toContain('formatLienUrgency');
    expect(jsonStr).toContain('formatFindingType');
    expect(jsonStr).not.toContain('"children":"{{finding.expected.urgency}}"');
  });

  it('lien deadlines page filter options are human-readable not raw tokens', () => {
    const jsonStr = JSON.stringify(opsLienDeadlinesPage.layout);
    expect(jsonStr).not.toContain('"label":"pending_approval"');
    expect(jsonStr).toContain('"label":"Pending approval"');
    expect(jsonStr).toContain('"label":"Approved"');
    expect(jsonStr).toContain('"label":"Rejected"');
  });

  it('credit review queue filter options are human-readable not raw tokens', () => {
    const jsonStr = JSON.stringify(opsCreditReviewQueuePage.layout);
    expect(jsonStr).not.toContain('"label":"pending_approval"');
    expect(jsonStr).toContain('"label":"Pending approval"');
    expect(jsonStr).toContain('"label":"High"');
    expect(jsonStr).toContain('"label":"Medium"');
    expect(jsonStr).toContain('"label":"Low"');
  });

  it('credit review queue "Open finding" link passes source=credit-review and return filter context', () => {
    const jsonStr = JSON.stringify(opsCreditReviewQueuePage.layout);
    expect(jsonStr).toContain('"source":"credit-review"');
    expect(jsonStr).toContain('returnSeverity');
    expect(jsonStr).toContain('returnStatus');
  });

  it('lien deadlines page "Open finding" link passes source=lien-deadlines', () => {
    const jsonStr = JSON.stringify(opsLienDeadlinesPage.layout);
    expect(jsonStr).toContain('"source":"lien-deadlines"');
    expect(jsonStr).toContain('returnStatus');
  });

  it('getUrgencyBorderClass returns correct Tailwind border class for each urgency level', () => {
    expect(
      evaluateExpression("{{getUrgencyBorderClass('overdue')}}", createExpressionContext())
    ).toBe('border-red-500');

    expect(
      evaluateExpression("{{getUrgencyBorderClass('critical')}}", createExpressionContext())
    ).toBe('border-red-500');

    expect(
      evaluateExpression("{{getUrgencyBorderClass('warning')}}", createExpressionContext())
    ).toBe('border-amber-500');

    expect(
      evaluateExpression("{{getUrgencyBorderClass('ok')}}", createExpressionContext())
    ).toBe('');

    expect(
      evaluateExpression("{{getUrgencyBorderClass('not_required')}}", createExpressionContext())
    ).toBe('');

    expect(
      evaluateExpression("{{getUrgencyBorderClass('')}}", createExpressionContext())
    ).toBe('');
  });

  it('lien deadlines page uses getUrgencyBorderClass helper not an inline ternary', () => {
    const jsonStr = JSON.stringify(opsLienDeadlinesPage.layout);
    expect(jsonStr).toContain('getUrgencyBorderClass');
    expect(jsonStr).not.toContain("urgency === 'overdue'");
  });

  it('lien deadlines page has tab controls for Preliminary Notices and Lien Waivers', () => {
    const jsonStr = JSON.stringify(opsLienDeadlinesPage.layout);
    expect(jsonStr).toContain('Preliminary Notices');
    expect(jsonStr).toContain('Lien Waivers');
    expect(jsonStr).toContain('activeTab');
  });

  it('account health queue filters findings to account-health-queue agent_key', () => {
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
      opsAccountHealthQueuePage.dataSources.findings as SupabaseDataSource,
      createExpressionContext({ state: { signalFilter: '%', priorityFilter: '%', statusFilter: 'pending_approval', customerFilter: '%' } })
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'account-health-queue');
  });

  it('account health queue filter options use human-readable labels', () => {
    const jsonStr = JSON.stringify(opsAccountHealthQueuePage.layout);
    expect(jsonStr).not.toContain('"label":"pending_approval"');
    expect(jsonStr).toContain('"label":"Pending approval"');
    expect(jsonStr).toContain('"label":"All signals"');
    expect(jsonStr).toContain('"label":"Lost"');
    expect(jsonStr).toContain('"label":"Dormant"');
    expect(jsonStr).toContain('"label":"At Risk"');
    expect(jsonStr).toContain('"label":"Growth Opportunity"');
    expect(jsonStr).toContain('"label":"Critical"');
    expect(jsonStr).toContain('"label":"High"');
  });

  it('account health queue no-op state shows explicit empty message', () => {
    const jsonStr = JSON.stringify(opsAccountHealthQueuePage.layout);
    expect(jsonStr).toContain('No account health signals');
    expect(jsonStr).toContain('data.findings.length === 0');
  });

  it('account health queue "Review thread" link passes source=account-health-queue', () => {
    const jsonStr = JSON.stringify(opsAccountHealthQueuePage.layout);
    expect(jsonStr).toContain('"source":"account-health-queue"');
    expect(jsonStr).toContain('returnStatus');
  });

  it('account health queue cards show stale-data alert when is_stale_data is set', () => {
    const jsonStr = JSON.stringify(opsAccountHealthQueuePage.layout);
    expect(jsonStr).toContain('is_stale_data');
    expect(jsonStr).toContain('Stale signals');
  });

  it('account health queue shows recommended_angle from expected block', () => {
    const jsonStr = JSON.stringify(opsAccountHealthQueuePage.layout);
    expect(jsonStr).toContain('recommended_angle');
  });

  it('ops finding detail has back link for account-health-queue source', () => {
    const jsonStr = JSON.stringify(opsFindingDetailPage.layout);
    expect(jsonStr).toContain("queueSource === 'account-health-queue'");
    expect(jsonStr).toContain('← Back to Account Health Queue');
    expect(jsonStr).toContain('/ops/account-health-queue');
  });

  it('ops finding detail default back link excludes account-health-queue source', () => {
    const jsonStr = JSON.stringify(opsFindingDetailPage.layout);
    expect(jsonStr).toContain("state.queueSource !== 'account-health-queue'");
  });

  it('formatOpsAgentLabel returns "Account Health Queue" for account-health-queue key', () => {
    expect(
      evaluateExpression("{{formatOpsAgentLabel('account-health-queue')}}", createExpressionContext())
    ).toBe('Account Health Queue');
  });

  it('getOpsWorkflowRoute returns /ops/account-health-queue route for account-health-queue', () => {
    expect(
      evaluateExpression("{{getOpsWorkflowRoute('account-health-queue')}}", createExpressionContext())
    ).toContain('/ops/account-health-queue');
  });

  it('ops dashboard recent-activity audit trail link carries search.event for context durability after reload', () => {
    // The "View audit trail" link in the recent-activity section must pass search.event = row_id
    // so the active-event indicator survives a page reload on the audit trail destination.
    const dashboardJson = JSON.stringify(opsFactoryDashboardPage.layout);
    // The link must target the audit trail route
    expect(dashboardJson).toContain('/ops/audit/');
    // The search prop must carry an event field keyed from row_id
    expect(dashboardJson).toContain('"event"');
    expect(dashboardJson).toContain('event.row_id');
  });

  it('ops dashboard workflow cards use formatOpsAgentLabel for human-readable titles', () => {
    const dashboardJson = JSON.stringify(opsFactoryDashboardPage.layout);
    expect(dashboardJson).toContain('formatOpsAgentLabel');
    expect(dashboardJson).toContain('getOpsWorkflowLinkLabel');
    expect(dashboardJson).toContain('getOpsWorkflowRoute');
  });
});
