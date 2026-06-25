import {
  METRIC_CATALOG,
  loadSavedDashboards,
  type SavedDashboard,
} from '@/lib/reporting/metric-catalog';

export const CONFIG_IMPACT_TAGS = [
  'rental-software-administrator:t1',
  'rental-software-administrator:t2',
  'rental-software-administrator:t3',
  'rental-software-administrator:t4',
] as const;

export type ConfigChangeDomain =
  | 'access_scope'
  | 'hierarchy_visibility'
  | 'billing_pricing'
  | 'reporting_audience';

export interface PendingConfigChangeDraft {
  domain: ConfigChangeDomain;
  targetId?: string;
  targetRole?: 'admin' | 'branch_manager' | 'field_operator' | 'read_only';
}

export interface ConfigImpactItem {
  id: string;
  label: string;
  detail: string;
  source: string;
  drillDownHref?: string;
}

export interface ConfigImpactPreview {
  previewKey: string;
  requiresHumanApproval: true;
  tags: readonly string[];
  groups: {
    users: ConfigImpactItem[];
    scopes: ConfigImpactItem[];
    pricing: ConfigImpactItem[];
    reporting: ConfigImpactItem[];
  };
  highRiskFlags: string[];
  uncertainties: string[];
}

interface ProfileRow {
  id?: unknown;
  display_name?: unknown;
  role?: unknown;
  tenant?: unknown;
}

interface ScopeHierarchyRow {
  ancestor_id?: unknown;
  ancestor_entity_type?: unknown;
  ancestor_name?: unknown;
  descendant_id?: unknown;
  descendant_entity_type?: unknown;
  descendant_name?: unknown;
  depth?: unknown;
}

interface ScopeConfigRow {
  scope_id?: unknown;
  entity_type?: unknown;
  name?: unknown;
}

interface RatePlanRow {
  id?: unknown;
  name?: unknown;
  effective_from?: unknown;
  effective_to?: unknown;
  branch_id?: unknown;
  customer_id?: unknown;
  billing_account_id?: unknown;
  category_id?: unknown;
  is_active?: unknown;
  daily_rate?: unknown;
  weekly_rate?: unknown;
  monthly_rate?: unknown;
}

interface ContractRow {
  entity_id?: unknown;
  data?: unknown;
}

interface LooseRecord {
  [key: string]: unknown;
}

const MAX_CONTRACT_PREVIEW_ITEMS = 12;
const MAX_METRIC_PREVIEW_ITEMS = 10;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function scopeLink(scopeType: string | undefined, scopeId: string | undefined): string | undefined {
  if (!scopeType || !scopeId) return undefined;
  if (scopeType === 'branch') return `/rental/availability?branch_id=${scopeId}`;
  if (scopeType === 'region') return `/entities/region/${scopeId}`;
  if (scopeType === 'company') return `/entities/company/${scopeId}`;
  return undefined;
}

function buildPreviewKey(draft: PendingConfigChangeDraft): string {
  return [draft.domain, draft.targetId || 'all', draft.targetRole || 'none'].join(':');
}

function isActivePlan(plan: RatePlanRow): boolean {
  const active = asBoolean(plan.is_active);
  return active ?? true;
}

function loadDashboardAudienceSnapshots(dashboardsInput?: unknown): SavedDashboard[] {
  if (Array.isArray(dashboardsInput)) return dashboardsInput as SavedDashboard[];
  return loadSavedDashboards();
}

function pushIfMissing(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

export function buildConfigChangeImpactPreview(input: {
  draft: PendingConfigChangeDraft;
  profiles?: unknown;
  hierarchy?: unknown;
  scopeConfig?: unknown;
  ratePlans?: unknown;
  contracts?: unknown;
  dashboards?: unknown;
}): ConfigImpactPreview {
  const profiles = asArray<ProfileRow>(input.profiles);
  const hierarchy = asArray<ScopeHierarchyRow>(input.hierarchy);
  const scopeConfig = asArray<ScopeConfigRow>(input.scopeConfig);
  const ratePlans = asArray<RatePlanRow>(input.ratePlans).filter(isActivePlan);
  const contracts = asArray<ContractRow>(input.contracts);
  const dashboards = loadDashboardAudienceSnapshots(input.dashboards);

  const users: ConfigImpactItem[] = [];
  const scopes: ConfigImpactItem[] = [];
  const pricing: ConfigImpactItem[] = [];
  const reporting: ConfigImpactItem[] = [];
  const highRiskFlags: string[] = [];
  const uncertainties: string[] = [];

  const draft = input.draft;
  const targetId = draft.targetId;

  if (profiles.length === 0) {
    uncertainties.push('User-role records are missing, so user blast radius is incomplete.');
  }

  if (hierarchy.length === 0 || scopeConfig.length === 0) {
    uncertainties.push('Org hierarchy/config records are incomplete, so scope inheritance may be under-counted.');
  }

  if (ratePlans.length === 0) {
    uncertainties.push('No active pricing plans were found, so contract/pricing blast radius may be incomplete.');
  }

  if (dashboards.length === 0) {
    uncertainties.push('No saved dashboard configurations were found for this admin session.');
  }

  const hierarchyMatches = hierarchy.filter((row) => {
    if (!targetId) return true;
    return asString(row.ancestor_id) === targetId || asString(row.descendant_id) === targetId;
  });

  hierarchyMatches.forEach((row, index) => {
    const ancestorType = asString(row.ancestor_entity_type);
    const descendantType = asString(row.descendant_entity_type);
    const descendantId = asString(row.descendant_id);
    scopes.push({
      id: `scope-${index}`,
      label: `${asString(row.ancestor_name) || 'Ancestor'} → ${asString(row.descendant_name) || 'Descendant'}`,
      detail: `Hierarchy depth ${asNumber(row.depth) ?? 0} across ${ancestorType || 'scope'} to ${descendantType || 'scope'}.`,
      source: 'v_org_scope_hierarchy',
      drillDownHref: scopeLink(descendantType, descendantId),
    });
  });

  const scopeConfigMatches = scopeConfig.filter((row) => !targetId || asString(row.scope_id) === targetId);
  scopeConfigMatches.forEach((row, index) => {
    const scopeType = asString(row.entity_type);
    const scopeId = asString(row.scope_id);
    scopes.push({
      id: `scope-config-${index}`,
      label: `${asString(row.name) || scopeId || 'Scope config'}`,
      detail: `Configuration override present for ${scopeType || 'scope'} records.`,
      source: 'v_org_scope_config',
      drillDownHref: scopeLink(scopeType, scopeId),
    });
  });

  const selectedProfiles = profiles.filter((profile) => {
    const role = asString(profile.role);
    if (draft.domain === 'access_scope' && draft.targetRole) {
      return role === draft.targetRole;
    }
    if (draft.domain === 'reporting_audience') {
      return role === 'admin' || role === 'branch_manager' || role === 'read_only';
    }
    return role === 'admin' || role === 'branch_manager';
  });

  selectedProfiles.forEach((profile, index) => {
    users.push({
      id: `user-${index}`,
      label: asString(profile.display_name) || asString(profile.id) || 'User',
      detail: `${asString(profile.role) || 'read_only'} role in tenant ${asString(profile.tenant) || 'default'}.`,
      source: 'profiles',
    });
  });

  const contractMatches = contracts.filter((contract) => {
    if (!targetId) return true;
    const data = asRecord(contract.data);
    const branchId = asString(data?.branch_id);
    const billingAccountId = asString(data?.billing_account_id);
    return targetId === branchId || targetId === billingAccountId;
  });

  const planMatches = ratePlans.filter((plan) => {
    if (!targetId) return true;
    return [
      asString(plan.branch_id),
      asString(plan.customer_id),
      asString(plan.billing_account_id),
      asString(plan.category_id),
    ].includes(targetId);
  });

  planMatches.forEach((plan, index) => {
    const rateBits = [
      asNumber(plan.daily_rate) ? `daily ${asNumber(plan.daily_rate)}` : undefined,
      asNumber(plan.weekly_rate) ? `weekly ${asNumber(plan.weekly_rate)}` : undefined,
      asNumber(plan.monthly_rate) ? `monthly ${asNumber(plan.monthly_rate)}` : undefined,
    ].filter(Boolean);

    pricing.push({
      id: `plan-${index}`,
      label: asString(plan.name) || asString(plan.id) || 'Rate plan',
      detail: `Active from ${asString(plan.effective_from) || 'unknown'}${asString(plan.effective_to) ? ` to ${asString(plan.effective_to)}` : ''}; ${rateBits.join(', ') || 'rate details unavailable'}.`,
      source: 'inventory_rate_plans',
      drillDownHref: '/rental/quoting',
    });
  });

  contractMatches.slice(0, MAX_CONTRACT_PREVIEW_ITEMS).forEach((contract, index) => {
    const data = asRecord(contract.data);
    pricing.push({
      id: `contract-${index}`,
      label: asString(data?.contract_number) || asString(contract.entity_id) || 'Contract',
      detail: `Contract scope branch ${asString(data?.branch_id) || 'unknown'} with billing account ${asString(data?.billing_account_id) || 'unknown'}.`,
      source: 'v_rental_contract_current',
      drillDownHref: asString(contract.entity_id) ? `/rental/contracts/${asString(contract.entity_id)}` : '/rental/contracts',
    });
  });

  dashboards.forEach((dashboard, index) => {
    const metricCount = Array.isArray(dashboard.metricKeys) ? dashboard.metricKeys.length : 0;
    reporting.push({
      id: `dashboard-${index}`,
      label: dashboard.name || dashboard.id,
      detail: `${metricCount} approved metric tile${metricCount === 1 ? '' : 's'} currently configured for this audience surface.`,
      source: 'dashboard-builder-local-config',
      drillDownHref: '/analytics/dashboards',
    });
  });

  const reportingCatalog = METRIC_CATALOG.filter((metric) => {
    if (draft.domain === 'billing_pricing') {
      return metric.subject === 'financial_health' || metric.subject === 'order_fulfillment';
    }
    if (draft.domain === 'reporting_audience') {
      return true;
    }
    return metric.subject === 'financial_health';
  });

  reportingCatalog.slice(0, MAX_METRIC_PREVIEW_ITEMS).forEach((metric, index) => {
    reporting.push({
      id: `metric-${index}`,
      label: metric.label,
      detail: `${metric.subject.replace('_', ' ')} metric sourced from ${metric.source}.`,
      source: 'metric-catalog',
      drillDownHref: metric.drillDownTo,
    });
  });

  if (draft.domain === 'access_scope' && !draft.targetRole) {
    uncertainties.push('Draft access change is missing a target role, so role-impact estimates are conservative.');
  }

  if (draft.targetId && hierarchyMatches.length === 0 && scopeConfigMatches.length === 0 && planMatches.length === 0) {
    uncertainties.push('No source records matched the selected target ID; manual review is required before applying any change.');
  }

  if (users.length > 20) {
    pushIfMissing(highRiskFlags, `High-risk blast radius: ${users.length} users may be affected.`);
  }
  if (scopes.length > 24) {
    pushIfMissing(highRiskFlags, `High-risk blast radius: ${scopes.length} scope/hierarchy records may be affected.`);
  }
  if (pricing.length > 20) {
    pushIfMissing(highRiskFlags, `High-risk blast radius: ${pricing.length} contract/pricing surfaces may be affected.`);
  }
  if (uncertainties.length > 0) {
    pushIfMissing(highRiskFlags, 'Uncertainty is present; keep this change in manual review.');
  }

  return {
    previewKey: buildPreviewKey(draft),
    requiresHumanApproval: true,
    tags: CONFIG_IMPACT_TAGS,
    groups: {
      users,
      scopes,
      pricing,
      reporting,
    },
    highRiskFlags,
    uncertainties,
  };
}
