import { describe, expect, it } from 'vitest';
import {
  buildConfigChangeImpactPreview,
  CONFIG_IMPACT_TAGS,
} from '@/lib/configChangeImpactAssistant';

describe('buildConfigChangeImpactPreview', () => {
  it('groups impacts across users, scopes, pricing, and reporting with source-backed records', () => {
    const preview = buildConfigChangeImpactPreview({
      draft: {
        domain: 'billing_pricing',
        targetId: 'branch-1',
      },
      profiles: [
        { id: 'u-admin', display_name: 'Admin Casey', role: 'admin', tenant: 'default' },
        { id: 'u-manager', display_name: 'Manager Pat', role: 'branch_manager', tenant: 'default' },
      ],
      hierarchy: [
        {
          ancestor_id: 'region-1',
          ancestor_entity_type: 'region',
          ancestor_name: 'Gulf Region',
          descendant_id: 'branch-1',
          descendant_entity_type: 'branch',
          descendant_name: 'Houston Branch',
          depth: 1,
        },
      ],
      scopeConfig: [
        {
          scope_id: 'branch-1',
          entity_type: 'branch',
          name: 'Houston Branch',
        },
      ],
      ratePlans: [
        {
          id: 'plan-1',
          name: 'Houston Prime',
          effective_from: '2026-06-01',
          branch_id: 'branch-1',
          is_active: true,
          daily_rate: 120,
        },
      ],
      contracts: [
        {
          entity_id: 'contract-1',
          data: {
            contract_number: 'RC-101',
            branch_id: 'branch-1',
            billing_account_id: 'billing-1',
          },
        },
      ],
      dashboards: [
        {
          id: 'db-1',
          name: 'Revenue board',
          metricKeys: ['period_revenue'],
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });

    expect(preview.previewKey).toBe('billing_pricing:branch-1:none');
    expect(preview.tags).toEqual(CONFIG_IMPACT_TAGS);
    expect(preview.requiresHumanApproval).toBe(true);
    expect(preview.groups.users.length).toBeGreaterThan(0);
    expect(preview.groups.scopes.length).toBeGreaterThan(0);
    expect(preview.groups.pricing.length).toBeGreaterThan(0);
    expect(preview.groups.reporting.length).toBeGreaterThan(0);
    expect(preview.groups.pricing.some((item) => item.source === 'inventory_rate_plans')).toBe(true);
    expect(preview.groups.pricing.some((item) => item.source === 'v_rental_contract_current')).toBe(true);
  });

  it('flags uncertainty and broad blast radius for high-impact access changes', () => {
    const preview = buildConfigChangeImpactPreview({
      draft: {
        domain: 'access_scope',
      },
      profiles: Array.from({ length: 24 }, (_, index) => ({
        id: `user-${index}`,
        display_name: `User ${index}`,
        role: 'branch_manager',
        tenant: 'default',
      })),
      hierarchy: [],
      scopeConfig: [],
      ratePlans: [],
      contracts: [],
      dashboards: [],
    });

    expect(preview.uncertainties.length).toBeGreaterThan(0);
    expect(preview.highRiskFlags.some((flag) => flag.includes('High-risk blast radius'))).toBe(true);
    expect(preview.highRiskFlags.some((flag) => flag.includes('Uncertainty'))).toBe(true);
  });

  it('scopes user impact to the specified target role for access_scope changes', () => {
    const profiles = [
      { id: 'u-admin', display_name: 'Admin A', role: 'admin', tenant: 'default' },
      { id: 'u-manager', display_name: 'Manager B', role: 'branch_manager', tenant: 'default' },
      { id: 'u-operator', display_name: 'Operator C', role: 'field_operator', tenant: 'default' },
    ];

    const preview = buildConfigChangeImpactPreview({
      draft: { domain: 'access_scope', targetRole: 'field_operator' },
      profiles,
      hierarchy: [{ ancestor_id: 'r1', ancestor_entity_type: 'region', ancestor_name: 'West', descendant_id: 'b1', descendant_entity_type: 'branch', descendant_name: 'LA Branch', depth: 1 }],
      scopeConfig: [{ scope_id: 'b1', entity_type: 'branch', name: 'LA Branch' }],
      ratePlans: [],
      contracts: [],
      dashboards: [],
    });

    // Only the field_operator profile should appear in the users group
    expect(preview.groups.users).toHaveLength(1);
    expect(preview.groups.users[0].label).toBe('Operator C');
    expect(preview.groups.users[0].source).toBe('profiles');
    expect(preview.previewKey).toBe('access_scope:all:field_operator');
  });

  it('surfaces hierarchy and scope records as traceable scope items for hierarchy_visibility changes', () => {
    const preview = buildConfigChangeImpactPreview({
      draft: { domain: 'hierarchy_visibility', targetId: 'region-west' },
      profiles: [
        { id: 'u-mgr', display_name: 'Regional Manager', role: 'branch_manager', tenant: 'default' },
      ],
      hierarchy: [
        {
          ancestor_id: 'region-west',
          ancestor_entity_type: 'region',
          ancestor_name: 'Western Region',
          descendant_id: 'branch-la',
          descendant_entity_type: 'branch',
          descendant_name: 'LA Branch',
          depth: 1,
        },
        {
          ancestor_id: 'region-west',
          ancestor_entity_type: 'region',
          ancestor_name: 'Western Region',
          descendant_id: 'branch-sf',
          descendant_entity_type: 'branch',
          descendant_name: 'SF Branch',
          depth: 1,
        },
      ],
      scopeConfig: [
        { scope_id: 'region-west', entity_type: 'region', name: 'Western Region' },
      ],
      ratePlans: [],
      contracts: [],
      dashboards: [],
    });

    // Hierarchy items must reference the org hierarchy view as their source
    expect(preview.groups.scopes.some((item) => item.source === 'v_org_scope_hierarchy')).toBe(true);
    // Scope config items must reference the scope config view as their source
    expect(preview.groups.scopes.some((item) => item.source === 'v_org_scope_config')).toBe(true);
    // Branch scope items must expose a drill-down href scoped to the branch
    const branchScopeItems = preview.groups.scopes.filter((item) => item.drillDownHref?.includes('/rental/availability'));
    expect(branchScopeItems.length).toBeGreaterThan(0);
  });

  it('includes all reporting dashboard and metric-catalog entries for reporting_audience changes', () => {
    const preview = buildConfigChangeImpactPreview({
      draft: { domain: 'reporting_audience' },
      profiles: [
        { id: 'u-readonly', display_name: 'Read Only User', role: 'read_only', tenant: 'default' },
      ],
      hierarchy: [],
      scopeConfig: [],
      ratePlans: [],
      contracts: [],
      dashboards: [
        { id: 'db-exec', name: 'Executive Dashboard', metricKeys: ['period_revenue', 'fleet_utilization'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });

    // read_only users are included for reporting_audience changes
    expect(preview.groups.users.some((u) => u.label === 'Read Only User')).toBe(true);
    // Dashboard items must reference the dashboard builder as their source
    expect(preview.groups.reporting.some((item) => item.source === 'dashboard-builder-local-config')).toBe(true);
    // Metric catalog items must reference the metric catalog as their source
    expect(preview.groups.reporting.some((item) => item.source === 'metric-catalog')).toBe(true);
    // Drill-down hrefs on metric items must route to the analytics section
    const metricItems = preview.groups.reporting.filter((item) => item.source === 'metric-catalog');
    expect(metricItems.every((item) => !item.drillDownHref || item.drillDownHref.startsWith('/'))).toBe(true);
  });

  it('surfaces explicit uncertainty and requires human review when target ID matches no source records', () => {
    const preview = buildConfigChangeImpactPreview({
      draft: { domain: 'billing_pricing', targetId: 'nonexistent-branch-xyz' },
      profiles: [
        { id: 'u-admin', display_name: 'Admin', role: 'admin', tenant: 'default' },
      ],
      hierarchy: [
        { ancestor_id: 'region-1', ancestor_entity_type: 'region', ancestor_name: 'East', descendant_id: 'branch-1', descendant_entity_type: 'branch', descendant_name: 'Boston', depth: 1 },
      ],
      scopeConfig: [
        { scope_id: 'branch-1', entity_type: 'branch', name: 'Boston' },
      ],
      ratePlans: [
        { id: 'plan-1', name: 'East Prime', branch_id: 'branch-1', is_active: true, effective_from: '2026-01-01' },
      ],
      contracts: [],
      dashboards: [],
    });

    // No source records match the nonexistent target — must surface explicit uncertainty
    expect(preview.uncertainties.some((u) => u.toLowerCase().includes('no source records matched'))).toBe(true);
    // Uncertainty must trigger a high-risk flag for manual review
    expect(preview.highRiskFlags.some((f) => f.toLowerCase().includes('uncertainty'))).toBe(true);
    // The preview must always require human approval regardless
    expect(preview.requiresHumanApproval).toBe(true);
  });
});
