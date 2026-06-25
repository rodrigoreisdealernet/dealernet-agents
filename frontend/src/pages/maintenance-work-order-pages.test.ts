import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import maintenanceWorkOrderDetailPage from './maintenance-work-order-detail.json';
import type { SupabaseDataSource } from '@/engine/types';

// ---------------------------------------------------------------------------
// Structural search helpers reused across behavioral tests
// ---------------------------------------------------------------------------

type AnyNode = Record<string, unknown>;

/** Recursively search a JSON tree for nodes matching a predicate. */
function findAll(node: unknown, predicate: (n: AnyNode) => boolean): AnyNode[] {
  const results: AnyNode[] = [];
  if (!node || typeof node !== 'object') return results;
  if (Array.isArray(node)) {
    for (const item of node) results.push(...findAll(item, predicate));
    return results;
  }
  const record = node as AnyNode;
  if (predicate(record)) results.push(record);
  for (const v of Object.values(record)) results.push(...findAll(v, predicate));
  return results;
}

/** Find the first node matching a predicate in the tree. */
function findFirst(node: unknown, predicate: (n: AnyNode) => boolean): AnyNode | null {
  const all = findAll(node, predicate);
  return all.length > 0 ? all[0] : null;
}

/** Find a Button node by its label text. */
function findButton(node: unknown, label: string): AnyNode | null {
  return findFirst(node, (n) => n.type === 'Button' && (n.props as AnyNode)?.children === label);
}

/** Recursively collect all apiCall actions in a tree. */
function findApiCalls(node: unknown, fn: string): AnyNode[] {
  return findAll(node, (n) => n.action === 'apiCall' && n.function === fn);
}

/** Recursively collect all actions of a given type in a tree. */
function findActions(node: unknown, action: string): AnyNode[] {
  return findAll(node, (n) => n.action === action);
}

describe('maintenance work order page definitions', () => {
  it('builds the work-order billing summary query from the view by id', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { maintenance_record_id: 'wo-1' },
      error: null,
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: singleMock,
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    await executeSupabaseQuery(
      client as never,
      maintenanceWorkOrderDetailPage.dataSources.workOrder as SupabaseDataSource,
      createExpressionContext({ params: { id: 'wo-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('v_maintenance_work_order_billing');
    expect(query.select).toHaveBeenCalledWith(
      'maintenance_record_id, name, work_order_status, maintenance_type, asset_id, is_customer_billable, billing_account_id, invoice_id, invoice_status, cost_line_count, internal_subtotal, sell_subtotal, tax_total, sell_total, created_at, last_updated_at'
    );
    expect(query.eq).toHaveBeenCalledWith('maintenance_record_id', 'wo-1');
  });

  it('builds the cost-lines list query filtered by maintenance_record_id', () => {
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
      maintenanceWorkOrderDetailPage.dataSources.costLines as SupabaseDataSource,
      createExpressionContext({ params: { id: 'wo-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('maintenance_cost_lines');
    expect(query.select).toHaveBeenCalledWith(
      'id, line_type, description, quantity, unit_cost, sell_amount, cost_total, sell_line_total, is_taxable, tax_rate, tax_amount, notes, created_at'
    );
    expect(query.eq).toHaveBeenCalledWith('maintenance_record_id', 'wo-1');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: true });
  });

  it('builds the invoice relationship lookup query scoped by maintenance_record_id', () => {
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
      maintenanceWorkOrderDetailPage.dataSources.workOrderInvoiceRelationship as SupabaseDataSource,
      createExpressionContext({ params: { id: 'wo-1' } })
    );

    expect(client.from).toHaveBeenCalledWith('relationships_v2');
    expect(query.select).toHaveBeenCalledWith('parent_id, created_at');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'relationship_type', 'invoice:generated_from:maintenance_work_order');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'is_current', true);
    expect(query.eq).toHaveBeenNthCalledWith(3, 'child_id', 'wo-1');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it('workOrderInvoiceRelationship data source uses single:true so result is an object not an array', async () => {
    const singleMock = vi.fn().mockResolvedValue({ data: { parent_id: 'inv-1', created_at: '' }, error: null });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: singleMock,
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    const result = await executeSupabaseQuery(
      client as never,
      maintenanceWorkOrderDetailPage.dataSources.workOrderInvoiceRelationship as SupabaseDataSource,
      createExpressionContext({ params: { id: 'wo-1' } })
    );

    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ parent_id: 'inv-1', created_at: '' });
  });

  it('loads related entity collections needed to render human-readable asset, billing, and invoice context', () => {
    expect(maintenanceWorkOrderDetailPage.dataSources.assets as SupabaseDataSource).toMatchObject({
      type: 'supabase',
      table: 'entities',
      select: 'id, entity_versions!inner(data, is_current)',
      filters: [
        { field: 'entity_type', op: 'eq', value: 'asset' },
        { field: 'entity_versions.is_current', op: 'eq', value: true },
      ],
    });

    expect(maintenanceWorkOrderDetailPage.dataSources.assetCategories as SupabaseDataSource).toMatchObject({
      filters: [
        { field: 'entity_type', op: 'eq', value: 'asset_category' },
        { field: 'entity_versions.is_current', op: 'eq', value: true },
      ],
    });

    expect(maintenanceWorkOrderDetailPage.dataSources.branches as SupabaseDataSource).toMatchObject({
      filters: [
        { field: 'entity_type', op: 'eq', value: 'branch' },
        { field: 'entity_versions.is_current', op: 'eq', value: true },
      ],
    });

    expect(maintenanceWorkOrderDetailPage.dataSources.billingAccounts as SupabaseDataSource).toMatchObject({
      filters: [
        { field: 'entity_type', op: 'eq', value: 'billing_account' },
        { field: 'entity_versions.is_current', op: 'eq', value: true },
      ],
    });

    expect(maintenanceWorkOrderDetailPage.dataSources.invoices as SupabaseDataSource).toMatchObject({
      filters: [
        { field: 'entity_type', op: 'eq', value: 'invoice' },
        { field: 'entity_versions.is_current', op: 'eq', value: true },
      ],
    });
  });

  it('renders readable related-context and billing drill-downs instead of raw asset/account ids', () => {
    const serializedLayout = JSON.stringify(maintenanceWorkOrderDetailPage.layout);

    expect(serializedLayout).toContain('Related Context');
    expect(serializedLayout).toContain("lookupEntityFieldById(data.assets, data.workOrder.asset_id, 'name', 'identifier')");
    expect(serializedLayout).toContain("lookupEntityFieldById(data.assetCategories, lookupEntityFieldById(data.assets, data.workOrder.asset_id, 'asset_category_id', 'category_id'), 'name')");
    expect(serializedLayout).toContain("lookupEntityFieldById(data.branches, lookupEntityFieldById(data.assets, data.workOrder.asset_id, 'branch_id'), 'name')");
    expect(serializedLayout).toContain("lookupEntityFieldById(data.billingAccounts, data.workOrder.billing_account_id, 'name', 'account_number')");
    expect(serializedLayout).toContain('/entities/asset/{{data.workOrder.asset_id}}');
    expect(serializedLayout).toContain('/rental/inspection-comparison?asset_id={{data.workOrder.asset_id}}&work_order_id={{params.id}}');
    expect(serializedLayout).toContain('/entities/billing_account/{{data.workOrder.billing_account_id}}');
    expect(serializedLayout).toContain("/entities/invoice/{{data.workOrderInvoiceRelationship.parent_id || data.workOrder.invoice_id}}");
    expect(serializedLayout).toContain("View Invoice {{lookupEntityFieldById(data.invoices, data.workOrderInvoiceRelationship.parent_id || data.workOrder.invoice_id, 'invoice_number', 'name')}} →");
    expect(serializedLayout).toContain("Bill to {{lookupEntityFieldById(data.billingAccounts, data.workOrder.billing_account_id, 'name', 'account_number')}} · Sell Total {{formatCurrency(data.workOrder.sell_total || 0)}}");
    expect(serializedLayout).not.toContain('Asset ID');
    expect(serializedLayout).not.toContain("{{data.workOrder.billing_account_id || '—'}}");
  });

  it('Generate Draft Invoice button has onClick wired to generateMaintenanceInvoice custom handler', () => {
    const layout = maintenanceWorkOrderDetailPage.layout;

    function findButton(node: Record<string, unknown>): Record<string, unknown> | null {
      if (node.type === 'Button' && (node.props as Record<string, unknown>)?.children === 'Generate Draft Invoice') {
        return node;
      }
      const children = node.children as Record<string, unknown>[] | undefined;
      if (Array.isArray(children)) {
        for (const child of children) {
          const found = findButton(child as Record<string, unknown>);
          if (found) return found;
        }
      }
      return null;
    }

    const button = findButton(layout as unknown as Record<string, unknown>);
    expect(button).not.toBeNull();

    const onClick = (button?.props as Record<string, unknown>)?.onClick as Record<string, unknown> | undefined;
    expect(onClick?.action).toBe('custom');
    expect(onClick?.handler).toBe('generateMaintenanceInvoice');

    const payload = onClick?.payload as Record<string, unknown> | undefined;
    expect(typeof payload?.maintenanceRecordId).toBe('string');
    expect(typeof payload?.billingAccountId).toBe('string');
  });

  it('loads service history for the asset linked to the work order', () => {
    expect(maintenanceWorkOrderDetailPage.dataSources.serviceHistory as SupabaseDataSource).toMatchObject({
      type: 'supabase',
      table: 'v_asset_service_history',
      filters: [
        { field: 'asset_id', op: 'eq', value: '{{data.workOrder.asset_id}}' },
      ],
    });

    const src = maintenanceWorkOrderDetailPage.dataSources.serviceHistory as SupabaseDataSource;
    expect(src.select).toContain('service_record_id');
    expect(src.select).toContain('service_record_type');
    expect(src.select).toContain('outcome');
    expect(src.select).toContain('downtime_minutes');
    expect(src.order?.[0]).toMatchObject({ column: 'service_sort_at', ascending: false });
  });

  it('renders a Repair Documentation Copilot panel with prior faults and documentation prompts', () => {
    const serializedLayout = JSON.stringify(maintenanceWorkOrderDetailPage.layout);

    expect(serializedLayout).toContain('Repair Documentation Copilot');
    expect(serializedLayout).toContain('Prior faults');
    expect(serializedLayout).toContain('Documentation prompts');
    expect(serializedLayout).toContain('Fault description');
    expect(serializedLayout).toContain('Repair action taken');
    expect(serializedLayout).toContain('Labor hours');
    expect(serializedLayout).toContain('Parts used');
    expect(serializedLayout).toContain('Technician findings');
  });

  it('copilot prior-faults table rows expression calls buildRepairCopilotPacket with workOrder and serviceHistory', () => {
    // Behavioral: fails if the copilot library is unwired from the prior-faults table
    const serializedLayout = JSON.stringify(maintenanceWorkOrderDetailPage.layout);
    expect(serializedLayout).toContain('buildRepairCopilotPacket(data.workOrder, data.serviceHistory).priorFaults}}');
  });

  it('copilot ConditionalRender conditions use buildRepairCopilotPacket priorFaults length, not inline filter', () => {
    // Behavioral: fails if the copilot wiring is replaced by an inline filter expression
    const serializedLayout = JSON.stringify(maintenanceWorkOrderDetailPage.layout);
    expect(serializedLayout).toContain('buildRepairCopilotPacket(data.workOrder, data.serviceHistory).priorFaults.length > 0');
    expect(serializedLayout).toContain('buildRepairCopilotPacket(data.workOrder, data.serviceHistory).priorFaults.length === 0');
    // Must NOT fall back to duplicating copilot fault-extraction logic inline
    expect(serializedLayout).not.toContain("(data.serviceHistory || []).filter(r => r.outcome === 'fail'");
  });

  it('copilot panel recommendation text is sourced from buildRepairCopilotPacket', () => {
    // Behavioral: fails if the copilot recommendation is removed or hardcoded
    const serializedLayout = JSON.stringify(maintenanceWorkOrderDetailPage.layout);
    expect(serializedLayout).toContain('buildRepairCopilotPacket(data.workOrder, data.serviceHistory).recommendation');
  });

  it('prior faults table columns match PriorFaultRecord fields from copilot library', () => {
    // Behavioral: fails if the table column keys diverge from the copilot PriorFaultRecord shape
    const faultsTable = findFirst(maintenanceWorkOrderDetailPage.layout, (n) => {
      const rows = (n.props as AnyNode)?.rows as string | undefined;
      return typeof rows === 'string' && rows.includes('buildRepairCopilotPacket') && rows.includes('priorFaults');
    });
    expect(faultsTable).not.toBeNull();

    const columns = ((faultsTable?.props as AnyNode)?.columns as AnyNode[]) ?? [];
    const keys = columns.map((c) => c.key as string);
    expect(keys).toContain('label');
    expect(keys).toContain('serviceType');
    expect(keys).toContain('outcome');
    expect(keys).toContain('occurredAt');
    expect(keys).toContain('source');
  });

  it('renders an escalation panel with first-class escalation reasons', () => {
    const serializedLayout = JSON.stringify(maintenanceWorkOrderDetailPage.layout);

    expect(serializedLayout).toContain('Escalation');
    expect(serializedLayout).toContain('Exceeds branch skill');
    expect(serializedLayout).toContain('Exceeds authorization limit');
    expect(serializedLayout).toContain('Parts unavailable');
    expect(serializedLayout).toContain('Safety concern');
  });

  it('renders a Service History panel showing recent service records', () => {
    const serializedLayout = JSON.stringify(maintenanceWorkOrderDetailPage.layout);

    expect(serializedLayout).toContain('Service History');
    expect(serializedLayout).toContain('data.serviceHistory');
  });

  it('copilot panel asserts technician is the disposition boundary', () => {
    const serializedLayout = JSON.stringify(maintenanceWorkOrderDetailPage.layout);

    expect(serializedLayout).toContain('never auto-closes or auto-certifies');
  });

  // ---------------------------------------------------------------------------
  // Behavioral tests — wiring must remain intact; these fail if removed
  // ---------------------------------------------------------------------------

  it('Document Repair button in copilot panel opens the documentRepair modal', () => {
    const btn = findButton(maintenanceWorkOrderDetailPage.layout, 'Document Repair');
    expect(btn).not.toBeNull();

    const onClick = (btn?.props as AnyNode)?.onClick as AnyNode | undefined;
    expect(onClick?.action).toBe('openModal');
    expect(onClick?.modalId).toBe('documentRepair');
  });

  it('documentRepair modal has Textarea inputs for fault_description, repair_action, technician_findings', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.documentRepair;
    expect(modal).toBeDefined();

    const textareas = findAll(modal, (n) => n.type === 'Textarea');
    const names = textareas.map((t) => (t.props as AnyNode)?.name as string);

    expect(names).toContain('repair_fault_description');
    expect(names).toContain('repair_action');
    expect(names).toContain('repair_technician_findings');
  });

  it('documentRepair modal has Input for labor_hours', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.documentRepair;
    const inputs = findAll(modal, (n) => n.type === 'Input');
    const names = inputs.map((i) => (i.props as AnyNode)?.name as string);
    expect(names).toContain('repair_labor_hours');
  });

  it('documentRepair modal Save button calls rental_upsert_entity_current_state with maintenance_record entity type', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.documentRepair;
    const calls = findApiCalls(modal, 'rental_upsert_entity_current_state');
    expect(calls.length).toBeGreaterThan(0);

    const call = calls[0];
    const callData = call.data as AnyNode;
    expect(callData.p_entity_type).toBe('maintenance_record');
    expect(typeof callData.p_entity_id).toBe('string');
    expect(callData.p_entity_id as string).toContain('data.workOrder.maintenance_record_id');

    // p_data is a mergeEntityData expression that preserves full entity state
    const pData = callData.p_data as string;
    expect(typeof pData).toBe('string');
    expect(pData).toContain('mergeEntityData');
    expect(pData).toContain('fault_description');
    expect(pData).toContain('repair_action');
    expect(pData).toContain('labor_hours');

    // Status must come from explicit technician selection (state.repair_status_value),
    // NOT from an auto-inferred expression like state.repair_parts_needed ? 'waiting_parts' : 'completed'
    // which would silently close the work order without technician disposition.
    expect(pData).toContain('state.repair_status_value');
    expect(pData).not.toContain("? 'waiting_parts'");
    expect(pData).not.toContain("? 'completed'");
  });

  it('documentRepair modal gates save on required fields: fault_description, repair_action, labor_hours, and status', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.documentRepair;
    const conditionals = findActions(modal, 'conditional');
    const validationConditional = conditionals.find((c) => {
      const condition = c.condition as string | undefined;
      return (
        condition?.includes('repair_fault_description') &&
        condition?.includes('repair_action') &&
        condition?.includes('repair_labor_hours')
      );
    });
    expect(validationConditional).toBeDefined();

    // The "then" branch should set an error, not save
    const thenAction = validationConditional?.then as AnyNode | undefined;
    expect(thenAction?.action).toBe('setState');
    expect(thenAction?.key).toBe('repair_error');

    // Validation must use explicit empty-string / null checks so that 0 labor hours
    // is accepted as a valid value rather than rejected by falsy coercion.
    const condition = validationConditional?.condition as string;
    expect(condition).toContain("repair_labor_hours === ''");

    // Status must also be required — fails if the outcome select is removed from the gate
    expect(condition).toContain('repair_status_value');
  });

  it('documentRepair modal has a Status Select for explicit technician-chosen outcome (disposition boundary)', () => {
    // Behavioral: fails if the outcome status select is removed, which would force an
    // auto-inferred status and let the save silently close the work order without
    // explicit technician disposition.
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.documentRepair;
    const selects = findAll(modal, (n) => n.type === 'Select');
    const statusSelect = selects.find((s) => (s.props as AnyNode)?.name === 'repair_status_value');
    expect(statusSelect).toBeDefined();

    const options = ((statusSelect?.props as AnyNode)?.options as AnyNode[]) ?? [];
    const values = options.map((o) => o.value as string);
    // Must offer meaningful terminal states a technician can explicitly select
    expect(values).toContain('completed');
    expect(values).toContain('waiting_parts');
    expect(values).toContain('escalated');
  });

  it('documentRepair modal refetches workOrder and serviceHistory on success', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.documentRepair;
    const calls = findApiCalls(modal, 'rental_upsert_entity_current_state');
    const refetches = findActions(calls[0]?.onSuccess, 'refetch') as AnyNode[];
    const sources = refetches.map((r) => r.source);
    expect(sources).toContain('workOrder');
    expect(sources).toContain('serviceHistory');
  });

  it('Escalate Work Order button in copilot panel opens the escalateWorkOrder modal', () => {
    const btn = findButton(maintenanceWorkOrderDetailPage.layout, 'Escalate Work Order');
    expect(btn).not.toBeNull();

    const onClick = (btn?.props as AnyNode)?.onClick as AnyNode | undefined;
    expect(onClick?.action).toBe('openModal');
    expect(onClick?.modalId).toBe('escalateWorkOrder');
  });

  it('escalateWorkOrder modal has Select with all six escalation reasons', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.escalateWorkOrder;
    const selects = findAll(modal, (n) => n.type === 'Select');
    expect(selects.length).toBeGreaterThan(0);

    const reasonSelect = selects.find((s) => (s.props as AnyNode)?.name === 'escalation_reason');
    expect(reasonSelect).toBeDefined();

    const options = ((reasonSelect?.props as AnyNode)?.options as AnyNode[]) ?? [];
    const values = options.map((o) => o.value as string);
    expect(values).toContain('exceeds_branch_skill');
    expect(values).toContain('exceeds_authorization_limit');
    expect(values).toContain('exceeds_time_available');
    expect(values).toContain('parts_unavailable');
    expect(values).toContain('safety_concern');
    expect(values).toContain('oem_specialist_required');
  });

  it('escalateWorkOrder modal saves with status=escalated via rental_upsert_entity_current_state', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.escalateWorkOrder;
    const calls = findApiCalls(modal, 'rental_upsert_entity_current_state');
    expect(calls.length).toBeGreaterThan(0);

    // p_data is a mergeEntityData expression; verify the escalated status and reason are wired
    const pData = (calls[0].data as AnyNode).p_data as string;
    expect(typeof pData).toBe('string');
    expect(pData).toContain('mergeEntityData');
    expect(pData).toContain("'escalated'");
    expect(pData).toContain('escalation_reason');
  });

  it('escalateWorkOrder modal requires an escalation_reason before saving', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.escalateWorkOrder;
    const conditionals = findActions(modal, 'conditional');
    const validationConditional = conditionals.find((c) => {
      const condition = c.condition as string | undefined;
      return condition?.includes('escalation_reason');
    });
    expect(validationConditional).toBeDefined();

    const thenAction = validationConditional?.then as AnyNode | undefined;
    expect(thenAction?.action).toBe('setState');
    expect(thenAction?.key).toBe('escalation_error');
  });

  it('Update Status button in Work Order Details card opens the updateStatus modal', () => {
    const btn = findButton(maintenanceWorkOrderDetailPage.layout, 'Update Status');
    expect(btn).not.toBeNull();

    const onClick = (btn?.props as AnyNode)?.onClick as AnyNode | undefined;
    expect(onClick?.action).toBe('openModal');
    expect(onClick?.modalId).toBe('updateStatus');
  });

  it('updateStatus modal has a Select with all valid work order status values', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.updateStatus;
    const selects = findAll(modal, (n) => n.type === 'Select');
    expect(selects.length).toBeGreaterThan(0);

    const options = ((selects[0].props as AnyNode)?.options as AnyNode[]) ?? [];
    const values = options.map((o) => o.value as string);
    expect(values).toContain('open');
    expect(values).toContain('in_progress');
    expect(values).toContain('completed');
    expect(values).toContain('waiting_parts');
    expect(values).toContain('escalated');
  });

  it('updateStatus modal Save button calls rental_upsert_entity_current_state and refetches workOrder', () => {
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.updateStatus;
    const calls = findApiCalls(modal, 'rental_upsert_entity_current_state');
    expect(calls.length).toBeGreaterThan(0);

    // p_data must use mergeEntityData with the full entity state and include the status
    // fallback expression so that accepting the visible default does not write an empty string.
    const pData = (calls[0].data as AnyNode).p_data as string;
    expect(typeof pData).toBe('string');
    expect(pData).toContain('mergeEntityData');
    // The status value must fall back to the current work_order_status when unchanged
    expect(pData).toContain('data.workOrder.work_order_status');

    const refetches = findActions(calls[0].onSuccess, 'refetch') as AnyNode[];
    const sources = refetches.map((r) => r.source);
    expect(sources).toContain('workOrder');
  });

  it('all three modal writes refetch serviceHistory on success to keep the on-page timeline in sync', () => {
    // Behavioral: fails if escalateWorkOrder or updateStatus remove the serviceHistory refetch,
    // which would leave the displayed service timeline stale after status/escalation writes.
    const modals = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals;

    for (const modalName of ['documentRepair', 'escalateWorkOrder', 'updateStatus'] as const) {
      const calls = findApiCalls(modals[modalName], 'rental_upsert_entity_current_state');
      expect(calls.length, `${modalName} must have an RPC call to check refetches on`).toBeGreaterThan(0);
      const refetches = findActions(calls[0]?.onSuccess, 'refetch') as AnyNode[];
      const sources = refetches.map((r) => r.source);
      expect(
        sources,
        `${modalName} onSuccess must refetch serviceHistory to keep the timeline current`
      ).toContain('serviceHistory');
    }
  });

  // ---------------------------------------------------------------------------
  // Regression: full-state preservation — partial-overwrite path
  // ---------------------------------------------------------------------------

  it('all three modal writes use mergeEntityData with the full current entity state to prevent partial-overwrite data loss', () => {
    // Behavioral: fails if any modal switches back to a hand-built object that
    // only includes the billing-view subset, which would silently erase fields
    // such as availability_impact, blocking_reason, opened_at, completed_at,
    // and any repair fields saved by a prior Document Repair operation.
    const modals = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals;

    for (const modalName of ['documentRepair', 'escalateWorkOrder', 'updateStatus'] as const) {
      const calls = findApiCalls(modals[modalName], 'rental_upsert_entity_current_state');
      expect(calls.length, `${modalName} must have an RPC call`).toBeGreaterThan(0);

      const pData = (calls[0].data as AnyNode).p_data;
      expect(
        typeof pData,
        `${modalName} p_data must be a mergeEntityData expression string, not a partial object`
      ).toBe('string');

      const pDataStr = pData as string;
      expect(
        pDataStr,
        `${modalName} p_data must call mergeEntityData`
      ).toContain('mergeEntityData');

      expect(
        pDataStr,
        `${modalName} p_data must source the full entity state from maintenanceRecordCurrentState`
      ).toContain('data.maintenanceRecordCurrentState.entity_versions[0].data');
    }
  });

  it('updateStatus modal falls back to current work_order_status when the select is not changed (empty-status save regression)', () => {
    // Behavioral: fails if the updateStatus action sends only state.status_update_value
    // without a fallback, which writes an empty status string when the user opens the
    // modal and clicks Save without touching the Select (initial state is '').
    const modal = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals?.updateStatus;
    const calls = findApiCalls(modal, 'rental_upsert_entity_current_state');
    expect(calls.length).toBeGreaterThan(0);

    const pDataStr = (calls[0].data as AnyNode).p_data as string;
    // The status arg must include the current work_order_status as a fallback
    // so that submitting with an unchanged select never writes an empty string.
    expect(pDataStr).toContain('data.workOrder.work_order_status');
  });

  it('all three modal writes refetch maintenanceRecordCurrentState on success so the full state cache is fresh before the next write', () => {
    // Behavioral: fails if any modal removes the maintenanceRecordCurrentState refetch,
    // which would leave a stale entity-state cache and cause the next mergeEntityData
    // call to overwrite with outdated data.
    const modals = (maintenanceWorkOrderDetailPage as unknown as { modals: Record<string, AnyNode> }).modals;

    for (const modalName of ['documentRepair', 'escalateWorkOrder', 'updateStatus'] as const) {
      const calls = findApiCalls(modals[modalName], 'rental_upsert_entity_current_state');
      const refetches = findActions(calls[0]?.onSuccess, 'refetch') as AnyNode[];
      const sources = refetches.map((r) => r.source);
      expect(
        sources,
        `${modalName} onSuccess must refetch maintenanceRecordCurrentState`
      ).toContain('maintenanceRecordCurrentState');
    }
  });
});
