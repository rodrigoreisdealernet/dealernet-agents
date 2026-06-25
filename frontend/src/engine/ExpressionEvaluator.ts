/**
 * Expression Evaluator for JSON-Driven UI Engine
 *
 * Handles {{expression}} syntax for dynamic values in JSON page definitions.
 * Expressions can reference: state, data, params, event, row, item, index, form
 */

import { get } from 'lodash-es';
import type { ExpressionContext } from './types';
import {
  formatLocalizedDateTime,
  resolveLocalePolicy,
  type ScopeLocaleConfig,
} from '@/lib/localePolicy';
import {
  buildRepairDocumentationPacket,
  type WorkOrderSignal,
  type ServiceHistoryRecord,
} from '@/lib/repairDocumentationCopilot';

// Security: keep lodash-es usage limited to `get` here; do not introduce `_.template`.
// Pattern to match {{expressions}}
const EXPRESSION_PATTERN = /\{\{(.+?)\}\}/g;

// Pattern to detect if a string contains any expressions
const HAS_EXPRESSION_PATTERN = /\{\{.+?\}\}/;

function getScopeConfigFromUnknown(value: unknown): ScopeLocaleConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const currencyMetadata =
    typeof candidate.currency_metadata === 'object' && candidate.currency_metadata !== null
      ? (candidate.currency_metadata as Record<string, unknown>)
      : {};
  return {
    localeCode:
      typeof candidate.locale_code === 'string'
        ? candidate.locale_code
        : typeof candidate.localeCode === 'string'
          ? candidate.localeCode
          : typeof currencyMetadata.locale_code === 'string'
            ? String(currencyMetadata.locale_code)
            : null,
    taxRegionCode:
      typeof candidate.tax_region_code === 'string'
        ? candidate.tax_region_code
        : typeof candidate.taxRegionCode === 'string'
          ? candidate.taxRegionCode
          : typeof currencyMetadata.tax_region_code === 'string'
            ? String(currencyMetadata.tax_region_code)
            : null,
    timezone:
      typeof candidate.timezone === 'string'
        ? candidate.timezone
        : typeof currencyMetadata.timezone === 'string'
          ? String(currencyMetadata.timezone)
          : null,
    currencyCode:
      typeof candidate.currency_code === 'string'
        ? candidate.currency_code
        : typeof candidate.currencyCode === 'string'
          ? candidate.currencyCode
          : typeof currencyMetadata.currency_code === 'string'
            ? String(currencyMetadata.currency_code)
            : null,
    currencyMinorUnit:
      typeof candidate.currency_minor_unit === 'number'
        ? candidate.currency_minor_unit
        : typeof candidate.currencyMinorUnit === 'number'
          ? candidate.currencyMinorUnit
          : typeof currencyMetadata.currency_minor_unit === 'number'
            ? Number(currencyMetadata.currency_minor_unit)
            : null,
  };
}

function resolveExpressionLocalePolicy(context?: ExpressionContext) {
  if (!context) return null;
  const data = (context.data as Record<string, unknown>) || {};
  const state = (context.state as Record<string, unknown>) || {};
  const policy = resolveLocalePolicy({
    userOverride:
      getScopeConfigFromUnknown(state.locale_override)
      || getScopeConfigFromUnknown(state.localeOverride)
      || null,
    branch:
      getScopeConfigFromUnknown(data.branch_scope_config)
      || getScopeConfigFromUnknown(data.branchScopeConfig)
      || getScopeConfigFromUnknown(data.branch)
      || null,
    region:
      getScopeConfigFromUnknown(data.region_scope_config)
      || getScopeConfigFromUnknown(data.regionScopeConfig)
      || getScopeConfigFromUnknown(data.region)
      || null,
    company:
      getScopeConfigFromUnknown(data.company_scope_config)
      || getScopeConfigFromUnknown(data.companyScopeConfig)
      || getScopeConfigFromUnknown(data.company)
      || null,
  });
  return policy.resolvedFrom === 'default' ? null : policy;
}

/**
 * Format a UTC ISO timestamp as "YYYY-MM-DD HH:mm UTC"
 * Returns an empty string for null/undefined, the raw value for unrecognised input.
 */
function formatDate(value: unknown, context?: ExpressionContext): string {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return String(value);
  const localePolicy = resolveExpressionLocalePolicy(context);
  if (localePolicy) {
    const localized = formatLocalizedDateTime(d, localePolicy, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    if (localized) return localized;
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function normalizeCurrencyCode(value: unknown): string {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'USD';
}

function isExpressionContext(value: unknown): value is ExpressionContext {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    'data' in candidate
    || 'state' in candidate
    || 'params' in candidate
    || 'event' in candidate
    || 'row' in candidate
    || 'item' in candidate
    || 'form' in candidate
  );
}

function formatCurrency(
  value: unknown,
  currencyCodeOrContext: unknown = 'USD',
  localeOrContext: unknown = 'en-US',
  contextOrUndefined?: ExpressionContext
): string {
  const context = isExpressionContext(contextOrUndefined)
    ? contextOrUndefined
    : isExpressionContext(localeOrContext)
      ? localeOrContext
      : isExpressionContext(currencyCodeOrContext)
        ? currencyCodeOrContext
        : undefined;
  const explicitCurrencyCode = isExpressionContext(currencyCodeOrContext) ? undefined : currencyCodeOrContext;
  const explicitLocale = isExpressionContext(localeOrContext) ? undefined : localeOrContext;
  const localePolicy = resolveExpressionLocalePolicy(context);
  const numeric = Number(value);
  const safeCurrencyCode = normalizeCurrencyCode(explicitCurrencyCode ?? localePolicy?.currencyCode ?? 'USD');
  const safeLocale =
    typeof explicitLocale === 'string' && explicitLocale.trim().length > 0
      ? explicitLocale
      : localePolicy?.localeCode || 'en-US';
  const resolvedMinimumFractionDigits = Number.isInteger(numeric) ? 0 : 2;
  const resolvedMaximumFractionDigits = Number.isInteger(numeric) ? 0 : 2;
  if (Number.isNaN(numeric)) {
    return new Intl.NumberFormat(safeLocale, {
      style: 'currency',
      currency: safeCurrencyCode,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(0);
  }
  return new Intl.NumberFormat(safeLocale, {
    style: 'currency',
    currency: safeCurrencyCode,
    minimumFractionDigits: resolvedMinimumFractionDigits,
    maximumFractionDigits: resolvedMaximumFractionDigits,
  }).format(numeric);
}

function formatDateTime(value: unknown, context?: ExpressionContext): string {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return String(value);
  const localePolicy = resolveExpressionLocalePolicy(context);
  const localized = localePolicy
    ? formatLocalizedDateTime(d, localePolicy, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    : new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    }).format(d);
  return localized.replace(/\b(AM|PM)\b/g, (match) => match.toLowerCase());
}

function formatPercent(value: unknown): string {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return '0%';
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(numeric);
}

const DEFAULT_OPS_WORKFLOW = {
  label: 'Business workflow',
  route: '/ops/findings',
  linkLabel: 'Open audit history',
};

const OPS_WORKFLOW_CONFIG: Record<string, typeof DEFAULT_OPS_WORKFLOW> = {
  'credit-analyst': {
    label: 'AR Collections',
    route: '/ops/collections?status=pending_approval',
    linkLabel: 'Review collections queue',
  },
  'credit-lien-control': {
    label: 'Credit Review & Lien Control',
    route: '/ops/credit-review?status=pending_approval',
    linkLabel: 'Review credit & lien obligations',
  },
  'revrec-analyst': {
    label: 'Revenue Recognition',
    route: '/ops/revenue-recognition?status=pending_approval',
    linkLabel: 'Review revenue opportunities',
  },
  'fleet-auditor': {
    label: 'Fleet Audits',
    route: '/ops/fleet-audits?status=pending_approval',
    linkLabel: 'Review fleet audits',
  },
  'damage-returns-charge-assistant': {
    label: 'Damage & Returns Charges',
    route: '/ops/findings?workflow=damage-returns-charge-assistant',
    linkLabel: 'Review return charges',
  },
  'quote-to-order-copilot': {
    label: 'Quote-to-Order Copilot',
    route: '/ops/findings?workflow=quote-to-order-copilot',
    linkLabel: 'Review draft quotes',
  },
  'account-health-queue': {
    label: 'Account Health Queue',
    route: '/ops/account-health-queue?status=pending_approval',
    linkLabel: 'Review account health queue',
  },
  'incident-compliance-queue': {
    label: 'Incident Compliance Queue',
    route: '/ops/incident-compliance-queue?status=pending_approval',
    linkLabel: 'Review incident compliance queue',
  },
};

function getOpsWorkflowConfig(value: unknown) {
  const key = String(value || '').trim().toLowerCase();
  return OPS_WORKFLOW_CONFIG[key] ?? {
    ...DEFAULT_OPS_WORKFLOW,
    label: String(value || DEFAULT_OPS_WORKFLOW.label),
  };
}

function formatOpsAgentLabel(value: unknown): string {
  return getOpsWorkflowConfig(value).label;
}

const FINDING_TYPE_LABELS: Record<string, string> = {
  collections_priority: 'Collections priority',
  billing_past_return: 'Billing past return',
  unbilled_on_rent: 'Unbilled while on rent',
  over_billed: 'Over-billed',
  credit_application_review: 'Credit application review',
  lien_deadline: 'Lien deadline',
  lien_waiver: 'Lien waiver',
  osha_log_follow_up: 'OSHA log follow-up',
  reportable_event_deadline: 'Reportable-event deadline',
  post_accident_testing: 'Post-accident testing',
  pm_due: 'PM Due',
  work_order_priority: 'Work Order Priority',
  not_available_unit: 'Not Available',
  parts_blocker: 'Parts Blocker',
};

function formatFindingType(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  return (
    FINDING_TYPE_LABELS[key]
    ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  );
}

function formatFindingStatus(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  switch (key) {
    case 'pending_approval': return 'Pending approval';
    case 'approved': return 'Approved';
    case 'rejected': return 'Rejected';
    case 'informational': return 'Informational';
    default: return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
}

function formatEscalationStage(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return 'Routine follow-up';
  switch (key) {
    case 'routine_follow_up': return 'Routine follow-up';
    case 'formal_notice': return 'Formal notice';
    case 'approaching_formal_escalation': return 'Approaching formal escalation';
    case 'legal_referral': return 'Legal referral';
    case 'collections_agency': return 'Collections agency';
    default: return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
}

function formatLienUrgency(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  switch (key) {
    case 'overdue': return 'Overdue';
    case 'critical': return 'Critical (≤5 days)';
    case 'warning': return 'Warning (≤14 days)';
    case 'ok': return 'On track';
    case 'not_required': return 'Not required';
    case 'unknown_jurisdiction': return 'Unknown jurisdiction — manual review';
    default: return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) || 'Unknown';
  }
}

function getUrgencyBorderClass(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'overdue' || key === 'critical') return 'border-red-500';
  if (key === 'warning') return 'border-amber-500';
  return '';
}

function formatOpsAuditLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return String(value).replace(/\bagent\b/gi, (match) => {
    if (match === match.toUpperCase()) return 'WORKFLOW';
    if (match === match.toLowerCase()) return 'workflow';
    if (match[0] === match[0].toUpperCase()) return 'Workflow';
    return 'workflow';
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function summarizeAuditPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return 'No additional details.';
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    const s = String(payload).trim();
    return s || 'No additional details.';
  }

  const p = payload as Record<string, unknown>;
  const parts: string[] = [];

  // Prefer prose fields first — most descriptive
  const rationale = typeof p.rationale === 'string' ? p.rationale.trim() : '';
  if (rationale) parts.push(rationale);

  const evidence = typeof p.evidence === 'string' ? p.evidence.trim() : '';
  if (evidence) parts.push(evidence);

  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  if (reason) parts.push(`Reason: ${reason}`);

  const approvedBy = typeof p.approved_by === 'string' ? p.approved_by.trim() : '';
  if (approvedBy) parts.push(`Approved by ${approvedBy}`);

  const eventType = typeof p.event_type === 'string' ? p.event_type.trim() : '';
  if (eventType) {
    const label = eventType.replace(/_/g, ' ');
    parts.push(label.charAt(0).toUpperCase() + label.slice(1));
  }

  if (parts.length > 0) return parts.join('. ');

  // Fallback: collect non-UUID human-readable scalar values from the payload
  for (const [key, val] of Object.entries(p)) {
    if (val === null || val === undefined) continue;
    const strVal = String(val).trim();
    if (!strVal || UUID_PATTERN.test(strVal)) continue;
    if (typeof val === 'number') {
      parts.push(`${key.replace(/_/g, ' ')}: ${val}`);
    } else if (typeof val === 'string') {
      parts.push(strVal);
    } else if (typeof val === 'boolean') {
      parts.push(`${key.replace(/_/g, ' ')}: ${val}`);
    }
  }

  return parts.length > 0 ? parts.join('. ') : 'No additional details.';
}

function formatOpsAuditSummary(payload: unknown, label: unknown): string {
  const normalizedLabel = formatOpsAuditLabel(label || 'Audit event');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return `${normalizedLabel} recorded.`;
  }

  const event = payload as Record<string, unknown>;
  const eventType = String(event.event_type || '').trim().toLowerCase();

  switch (eventType) {
    case 'finding_created':
      return 'Finding created and queued for review.';
    case 'adjustment_drafted':
      if (event.amount === null || event.amount === undefined || event.amount === '') {
        return 'Draft adjustment prepared (amount unavailable).';
      }
      return `Draft adjustment prepared for ${formatCurrency(event.amount, event.currency || 'USD')}.`;
    case 'finding_approved':
      return `Finding approved by ${event.approved_by || event.approver_name || 'an operator'}.`;
    case 'finding_rejected':
      return `Finding rejected${event.reason ? `: ${event.reason}` : '.'}`;
    default: {
      const narrative = event.summary || event.description || event.reason || event.note || event.message;
      if (narrative) return String(narrative);
      return `${normalizedLabel} recorded.`;
    }
  }
}

function formatRerentFulfillmentStatus(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  switch (key) {
    case 'pending_vendor_confirmation':
      return 'pending vendor confirmation';
    case 'vendor_confirmed':
      return 'vendor confirmed';
    case 'in_transit':
      return 'in transit from vendor';
    case 'fulfilled_external':
      return 'fulfilled externally';
    case 'vendor_unavailable':
      return 'vendor unavailable';
    default:
      return String(value || '');
  }
}

function formatRerentVendorPath(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  switch (key) {
    case 'primary_preferred':
      return 'primary preferred vendor';
    case 'secondary_preferred':
      return 'secondary preferred vendor';
    case 'manual_override':
      return 'manual override path';
    default:
      return String(value || '');
  }
}

function formatRerentUnitStatus(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  switch (key) {
    case 'requested':
      return 'Requested';
    case 'awarded':
      return 'Awarded';
    case 'dispatched':
      return 'Dispatched';
    case 'on_rent':
      return 'On Rent';
    case 'return_in_transit':
      return 'Return in Transit';
    case 'returned':
      return 'Returned';
    default:
      return String(value || '');
  }
}

function toNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? 0 : numeric;
}

function hasRerentUnitStatus(statusRecords: unknown, lineId: unknown): boolean {
  if (!lineId || !Array.isArray(statusRecords)) return false;
  const normalizedId = String(lineId);
  return statusRecords.some(
    (r) =>
      r !== null &&
      typeof r === 'object' &&
      String((r as Record<string, unknown>).order_line_id ?? '') === normalizedId &&
      String((r as Record<string, unknown>).status_key ?? '').trim() !== ''
  );
}

function hasAvailabilityShortage(
  rows: unknown,
  assetCategoryId: unknown,
  branchId: unknown,
  requestedQuantity: unknown
): boolean {
  return toNumber(requestedQuantity) > getAvailabilityField(rows, assetCategoryId, branchId, 'available_assets');
}

function hasRerentRoutingContext(
  fulfillmentSource: unknown,
  rerentFulfillmentStatus: unknown,
  shortageRoute: unknown
): boolean {
  if (String(fulfillmentSource || '').trim().toLowerCase() === 'external_rerent') {
    return true;
  }

  if (String(rerentFulfillmentStatus || '').trim() !== '') {
    return true;
  }

  return String(shortageRoute || '').trim().toLowerCase() === 'preferred_vendor';
}

function getFulfillmentChannelLabel(
  fulfillmentSource: unknown,
  rerentFulfillmentStatus: unknown,
  shortageRoute: unknown
): string {
  if (hasRerentRoutingContext(fulfillmentSource, rerentFulfillmentStatus, shortageRoute)) {
    return 'external rerent';
  }
  if (String(fulfillmentSource || '').trim().toLowerCase() === 'internal_substitute') {
    return 'internal substitute';
  }
  return 'internal stock';
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function buildRerentLineData(
  existingLineData: unknown,
  categoryId: unknown,
  requestedQuantity: unknown,
  availableQuantity: unknown,
  vendorPath: unknown,
  fulfillmentStatus: unknown,
  overrideReason: unknown,
  overrideRole: unknown
): Record<string, unknown> {
  const normalizedVendorPath = String(vendorPath || 'primary_preferred');
  const payload: Record<string, unknown> = {
    ...toRecord(existingLineData),
    status: 'rerent_pending',
    category_id: categoryId,
    quantity: toNumber(requestedQuantity),
    internal_available_quantity: toNumber(availableQuantity),
    fulfillment_source: 'external_rerent',
    shortage_route: 'preferred_vendor',
    rerent_vendor_path: normalizedVendorPath,
    rerent_fulfillment_status: fulfillmentStatus,
  };

  if (normalizedVendorPath === 'manual_override') {
    payload.manual_override_reason = String(overrideReason || '').trim();
    payload.manual_override_role = String(overrideRole || 'missing_auth_role');
  } else {
    delete payload.manual_override_reason;
    delete payload.manual_override_role;
  }

  return payload;
}

function buildSubstituteLineData(
  existingLineData: unknown,
  quoteLine: unknown,
  alternative: unknown,
  actorRole: unknown
): Record<string, unknown> {
  const normalizedLine = toRecord(quoteLine);
  const normalizedAlternative = toRecord(alternative);
  const payload: Record<string, unknown> = {
    ...toRecord(existingLineData),
    category_id: normalizedAlternative.asset_category_id ?? normalizedLine.asset_category_id,
    branch_id: normalizedAlternative.branch_id ?? normalizedLine.branch_id,
    status: 'pending',
    fulfillment_source: 'internal_substitute',
    shortage_route: normalizedAlternative.fit_type,
    substitute_recommendation: {
      line_entity_id: normalizedLine.line_entity_id,
      requested_quantity: normalizedLine.requested_quantity,
      original_branch_id: normalizedLine.branch_id,
      original_asset_category_id: normalizedLine.asset_category_id,
      selected_branch_id: normalizedAlternative.branch_id,
      selected_branch_name: normalizedAlternative.branch_name,
      selected_asset_category_id: normalizedAlternative.asset_category_id,
      selected_asset_category_name: normalizedAlternative.asset_category_name,
      selected_available_quantity: normalizedAlternative.available_quantity,
      fit_type: normalizedAlternative.fit_type,
      explanation: normalizedAlternative.explanation,
      selected_by_role: String(actorRole || 'unknown_role'),
    },
  };

  delete payload.rerent_vendor_path;
  delete payload.rerent_fulfillment_status;
  delete payload.manual_override_reason;
  delete payload.manual_override_role;

  return payload;
}

function getOpsWorkflowRoute(value: unknown): string {
  return getOpsWorkflowConfig(value).route;
}

function getOpsWorkflowLinkLabel(value: unknown): string {
  return getOpsWorkflowConfig(value).linkLabel;
}

type AvailabilityRow = {
  branch_id?: unknown;
  branch_name?: unknown;
  asset_category_id?: unknown;
  asset_category_name?: unknown;
  available_assets?: unknown;
};

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function filterAvailabilityRows(
  rows: unknown,
  scope: unknown,
  currentBranchId: unknown,
  search: unknown
): AvailabilityRow[] {
  if (!Array.isArray(rows)) return [];

  const normalizedScope = normalizeText(scope);
  const normalizedCurrentBranchId = normalizeText(currentBranchId);
  const normalizedSearch = normalizeText(search);

  return rows.filter((candidate): candidate is AvailabilityRow => {
    if (!candidate || typeof candidate !== 'object') return false;
    const row = candidate as AvailabilityRow;

    if (normalizedScope === 'current') {
      const rowBranchId = normalizeText(row.branch_id);
      if (!normalizedCurrentBranchId || rowBranchId !== normalizedCurrentBranchId) {
        return false;
      }
    }

    if (normalizedSearch) {
      const searchableText = `${normalizeText(row.asset_category_name)} ${normalizeText(row.branch_name)}`;
      if (!searchableText.includes(normalizedSearch)) {
        return false;
      }
    }

    return true;
  });
}

function countAvailabilityRows(
  rows: unknown,
  scope: unknown,
  currentBranchId: unknown,
  search: unknown
): number {
  return filterAvailabilityRows(
    rows,
    scope,
    currentBranchId,
    search
  ).length;
}

function getAvailabilityField(
  rows: unknown,
  assetCategoryId: unknown,
  branchId: unknown,
  /** Arbitrary numeric field on availability rows (commonly available_assets, total_assets, unavailable_assets, maintenance_due_assets, maintenance_overdue_assets) */
  field: unknown = 'available_assets'
): number {
  if (!Array.isArray(rows)) return 0;

  const normalizedCategoryId = normalizeText(assetCategoryId);
  if (!normalizedCategoryId) return 0;

  const normalizedBranchId = normalizeText(branchId);
  const normalizedField = String(field || 'available_assets');

  const match = rows.find((candidate): candidate is AvailabilityRow => {
    if (!candidate || typeof candidate !== 'object') return false;
    const row = candidate as AvailabilityRow;
    if (normalizeText(row.asset_category_id) !== normalizedCategoryId) return false;
    if (!normalizedBranchId) return true;
    return normalizeText(row.branch_id) === normalizedBranchId;
  });

  const numeric = Number(match && normalizedField in match ? (match as Record<string, unknown>)[normalizedField] : 0);
  return Number.isNaN(numeric) ? 0 : numeric;
}

function filterCatalogAssets(
  assets: unknown,
  selectedCategory: unknown,
  selectedBranch: unknown,
  search: unknown
): Record<string, unknown>[] {
  if (!Array.isArray(assets)) return [];

  const normalizedCategory = normalizeText(selectedCategory);
  const normalizedBranch = normalizeText(selectedBranch);
  const normalizedSearch = normalizeText(search);

  return assets.filter((candidate): candidate is Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object') return false;

    const assetCategoryId = normalizeText(
      get(candidate, 'entity_versions[0].data.asset_category_id')
      ?? get(candidate, 'entity_versions[0].data.category_id')
    );
    if (normalizedCategory && assetCategoryId !== normalizedCategory) return false;

    const assetBranchId = normalizeText(get(candidate, 'entity_versions[0].data.branch_id'));
    if (normalizedBranch && assetBranchId !== normalizedBranch) return false;

    if (normalizedSearch) {
      const rawTags = get(candidate, 'entity_versions[0].data.tags');
      const normalizedTags = Array.isArray(rawTags)
        ? rawTags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => normalizeText(tag))
          .join(' ')
        : '';
      const searchableFields = [
        get(candidate, 'entity_versions[0].data.name'),
        get(candidate, 'entity_versions[0].data.make'),
        get(candidate, 'entity_versions[0].data.model'),
        get(candidate, 'entity_versions[0].data.fuel_type'),
        get(candidate, 'entity_versions[0].data.meter_type'),
        get(candidate, 'entity_versions[0].data.condition'),
        get(candidate, 'entity_versions[0].data.identifier'),
      ];
      const searchableText = `${searchableFields.map((field) => normalizeText(field)).join(' ')} ${normalizedTags}`;
      if (!searchableText.includes(normalizedSearch)) return false;
    }

    return true;
  });
}

function countCatalogAssets(
  assets: unknown,
  selectedCategory: unknown,
  selectedBranch: unknown,
  search: unknown
): number {
  return filterCatalogAssets(assets, selectedCategory, selectedBranch, search).length;
}

/** Built-in helper functions available in expressions as formatDate(expr) etc. */
function splitFunctionArgs(argsExpression: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < argsExpression.length; i += 1) {
    const char = argsExpression[i];
    const previousChar = i > 0 ? argsExpression[i - 1] : null;

    if (quote) {
      current += char;
      if (char === quote && previousChar !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function lookupEntityFieldById(
  entities: unknown,
  id: unknown,
  ...fieldNames: unknown[]
): unknown {
  const normalizedId = id === null || id === undefined || id === '' ? null : String(id);
  if (!normalizedId) return 'N/A';
  if (!Array.isArray(entities)) return 'N/A';

  const match = entities.find((candidate) => {
    return Boolean(candidate && typeof candidate === 'object' && get(candidate, 'id') === normalizedId);
  });

  if (!match) return 'N/A';

  const lookupFields = fieldNames.map((field) => String(field)).filter(Boolean);
  const fieldsToCheck = lookupFields.length > 0
    ? lookupFields
    : ['name', 'invoice_number', 'contract_number', 'account_number'];

  for (const fieldName of fieldsToCheck) {
    const value = get(match, `entity_versions[0].data.${fieldName}`);
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return value;
    }
  }

  const fallbackName = get(match, 'entity_versions[0].data.name');
  if (fallbackName !== null && fallbackName !== undefined && String(fallbackName).trim() !== '') {
    return fallbackName;
  }

  return 'N/A';
}

function lookupRecordFieldById(
  records: unknown,
  id: unknown,
  fieldName: unknown,
  idField: unknown = 'id'
): unknown {
  if (!id || !Array.isArray(records)) return undefined;
  const normalizedId = String(id);

  const normalizedIdField = String(idField);
  const normalizedFieldName = String(fieldName || '');
  if (!normalizedFieldName) return undefined;

  const match = records.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    return String(get(candidate, normalizedIdField) ?? '') === normalizedId;
  });

  if (!match) return undefined;
  return get(match, normalizedFieldName);
}

function mergeRecordFieldById(
  records: unknown,
  id: unknown,
  idField: unknown = 'id',
  ...fieldValuePairs: unknown[]
): Record<string, unknown> {
  const normalizedId = id === null || id === undefined || id === '' ? null : String(id);
  const normalizedIdField = String(idField || 'id');

  const match = normalizedId && Array.isArray(records)
    ? records.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      return String(get(candidate, normalizedIdField) ?? '') === normalizedId;
    })
    : undefined;

  const baseRecord = match && typeof match === 'object'
    ? Object.fromEntries(
      Object.entries(match).filter(([key]) => key !== normalizedIdField && key !== 'version_id' && key !== 'version_number')
    )
    : {};

  const overrides: Record<string, unknown> = {};
  for (let i = 0; i < fieldValuePairs.length; i += 2) {
    const key = fieldValuePairs[i];
    if (typeof key !== 'string' || key.trim() === '') continue;
    overrides[key] = fieldValuePairs[i + 1];
  }

  return { ...baseRecord, ...overrides };
}

function ensureArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Storefront cart helpers
// ---------------------------------------------------------------------------

/** Damage waiver rate: 12% of rental subtotal */
const DAMAGE_WAIVER_RATE = 0.12;
/** Flat delivery fee in USD */
const DELIVERY_FEE_USD = 150;

/**
 * Compute the best-rate rental subtotal for a given number of rental days.
 * Uses monthly rate for ≥ 28 days, weekly for ≥ 7, daily otherwise.
 */
function computeRentalSubtotal(
  dailyRate: unknown,
  weeklyRate: unknown,
  monthlyRate: unknown,
  rentalDays: unknown
): number {
  const days = Math.max(0, Math.floor(toNumber(rentalDays)));
  if (days === 0) return 0;
  const daily = toNumber(dailyRate);
  const weekly = toNumber(weeklyRate);
  const monthly = toNumber(monthlyRate);
  if (monthly > 0 && days >= 28) return +(monthly * (days / 28)).toFixed(2);
  if (weekly > 0 && days >= 7) return +(weekly * (days / 7)).toFixed(2);
  return +(daily * days).toFixed(2);
}

/**
 * Compute damage waiver fee (12% of subtotal) when enabled.
 */
function computeDamageWaiverFee(subtotal: unknown, enabled: unknown): number {
  if (!enabled || enabled === 'false' || enabled === false) return 0;
  return +(toNumber(subtotal) * DAMAGE_WAIVER_RATE).toFixed(2);
}

/**
 * Flat delivery fee when delivery is enabled.
 */
function computeDeliveryFee(enabled: unknown): number {
  if (!enabled || enabled === 'false' || enabled === false) return 0;
  return DELIVERY_FEE_USD;
}

/**
 * Grand total: rental subtotal + optional damage waiver + optional delivery fee.
 */
function computeCartTotal(
  dailyRate: unknown,
  weeklyRate: unknown,
  monthlyRate: unknown,
  rentalDays: unknown,
  waiverEnabled: unknown,
  deliveryEnabled: unknown
): number {
  const subtotal = computeRentalSubtotal(dailyRate, weeklyRate, monthlyRate, rentalDays);
  const waiver = computeDamageWaiverFee(subtotal, waiverEnabled);
  const delivery = computeDeliveryFee(deliveryEnabled);
  return +(subtotal + waiver + delivery).toFixed(2);
}

/**
 * Filter cross-sell suggestions: assets in the same category, excluding the current asset,
 * capped at 3 results.
 */
function getCartCrossSellAssets(
  assets: unknown,
  categoryId: unknown,
  excludeAssetId: unknown
): Record<string, unknown>[] {
  if (!Array.isArray(assets)) return [];
  const normalizedCategory = normalizeText(categoryId);
  const normalizedExclude = excludeAssetId === null || excludeAssetId === undefined ? null : String(excludeAssetId);

  return assets
    .filter((candidate): candidate is Record<string, unknown> => {
      if (!candidate || typeof candidate !== 'object') return false;
      if (normalizedExclude && get(candidate, 'id') === normalizedExclude) return false;
      const assetCategoryId = normalizeText(
        get(candidate, 'entity_versions[0].data.asset_category_id')
        ?? get(candidate, 'entity_versions[0].data.category_id')
      );
      if (normalizedCategory && assetCategoryId !== normalizedCategory) return false;
      const status = normalizeText(get(candidate, 'entity_versions[0].data.status'));
      return status === 'available';
    })
    .slice(0, 3);
}

/**
 * Count cross-sell suggestions.
 */
function countCartCrossSellAssets(
  assets: unknown,
  categoryId: unknown,
  excludeAssetId: unknown
): number {
  return getCartCrossSellAssets(assets, categoryId, excludeAssetId).length;
}

/**
 * Wrapper that maps raw Supabase snake_case page data into the copilot library's
 * expected shapes and returns a fully-assembled RepairDocumentationPacket.
 *
 * Registered as a BUILT_IN so page JSON can call it from expressions:
 *   {{buildRepairCopilotPacket(data.workOrder, data.serviceHistory).recommendation}}
 *   {{buildRepairCopilotPacket(data.workOrder, data.serviceHistory).priorFaults}}
 */
function buildRepairCopilotPacket(workOrder: unknown, serviceHistory: unknown) {
  const wo = (workOrder && typeof workOrder === 'object')
    ? (workOrder as Record<string, unknown>)
    : null;

  const woSignal: WorkOrderSignal | null = wo
    ? {
        maintenanceRecordId: wo.maintenance_record_id,
        name: wo.name,
        maintenanceType: wo.maintenance_type,
        workOrderStatus: wo.work_order_status,
        assetId: wo.asset_id,
        notes: wo.notes,
        technicianId: wo.technician_id,
        openedAt: wo.opened_at ?? wo.created_at,
        completedAt: wo.completed_at,
      }
    : null;

  const rawHistory = Array.isArray(serviceHistory)
    ? (serviceHistory as Record<string, unknown>[])
    : [];

  const historyRecords: ServiceHistoryRecord[] = rawHistory.map((r) => ({
    serviceRecordId: r.service_record_id,
    serviceRecordType: r.service_record_type,
    serviceName: r.service_name,
    serviceType: r.service_type,
    outcome: r.outcome,
    status: r.status,
    openedAt: r.opened_at,
    completedAt: r.completed_at,
    costSummary: r.cost_summary,
    downtimeMinutes: r.downtime_minutes,
    serviceSortAt: r.service_sort_at,
  }));

  return buildRepairDocumentationPacket({
    workOrder: woSignal,
    serviceHistory: historyRecords,
  });
}

/**
 * Merge an existing entity-data JSONB object with a set of override fields,
 * returning the complete merged record ready to pass as p_data to
 * rental_upsert_entity_current_state.
 *
 * Usage (in page JSON expressions):
 *   {{mergeEntityData(data.maintenanceRecordCurrentState.entity_versions[0].data, 'status', 'completed', 'fault_description', state.repair_fault_description)}}
 *
 * The first argument is the full current entity data object.  Subsequent
 * arguments are key/value pairs that override or add fields.  Any field in the
 * existing data that is not listed in the overrides is preserved unchanged,
 * which prevents the SCD2 insert from silently erasing fields that are not
 * present in the billing-view projection.
 */
function mergeEntityData(
  existingData: unknown,
  ...keyValuePairs: unknown[]
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existingData !== null &&
    existingData !== undefined &&
    typeof existingData === 'object' &&
    !Array.isArray(existingData)
      ? { ...(existingData as Record<string, unknown>) }
      : {};

  for (let i = 0; i + 1 < keyValuePairs.length; i += 2) {
    const key = keyValuePairs[i];
    if (typeof key === 'string' && key.trim() !== '') {
      base[key] = keyValuePairs[i + 1];
    }
  }

  return base;
}

const BUILT_INS: Record<string, unknown> = {
  formatDate,
  formatDateTime,
  formatCurrency,
  formatPercent,
  formatOpsAgentLabel,
  formatOpsAuditLabel,
  summarizeAuditPayload,
  formatOpsAuditSummary,
  formatFindingType,
  formatFindingStatus,
  formatEscalationStage,
  formatLienUrgency,
  getUrgencyBorderClass,
  formatRerentFulfillmentStatus,
  formatRerentVendorPath,
  formatRerentUnitStatus,
  hasAvailabilityShortage,
  hasRerentRoutingContext,
  hasRerentUnitStatus,
  getFulfillmentChannelLabel,
  buildRerentLineData,
  buildSubstituteLineData,
  getOpsWorkflowRoute,
  getOpsWorkflowLinkLabel,
  lookupEntityFieldById,
  filterAvailabilityRows,
  countAvailabilityRows,
  getAvailabilityField,
  filterCatalogAssets,
  countCatalogAssets,
  lookupRecordFieldById,
  mergeRecordFieldById,
  ensureArray,
  computeRentalSubtotal,
  computeDamageWaiverFee,
  computeDeliveryFee,
  computeCartTotal,
  getCartCrossSellAssets,
  countCartCrossSellAssets,
  buildRepairCopilotPacket,
  mergeEntityData,
  uuid: () => crypto.randomUUID(),
};

/**
 * Check if a value contains expressions
 */
export function hasExpression(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return HAS_EXPRESSION_PATTERN.test(value);
}

/**
 * Check if a string is a pure expression (entire string is one expression)
 */
export function isPureExpression(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{{') || !trimmed.endsWith('}}')) return false;
  // Check that there's only one expression
  const matches = trimmed.match(EXPRESSION_PATTERN);
  return matches !== null && matches.length === 1 && matches[0] === trimmed;
}

function isEscaped(input: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && input[i] === '\\'; i -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function isQuotedLiteral(value: string): boolean {
  if (value.length < 2) return false;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
    return false;
  }

  for (let i = 1; i < value.length - 1; i += 1) {
    if (value[i] === quote && !isEscaped(value, i)) {
      return false;
    }
  }

  return true;
}

function splitTopLevel(expression: string, operator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];

    if (quote) {
      current += char;
      if (char === quote && !isEscaped(expression, i)) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (depth === 0 && expression.slice(i, i + operator.length) === operator) {
      parts.push(current.trim());
      current = '';
      i += operator.length - 1;
      continue;
    }

    current += char;
  }

  parts.push(current.trim());
  return parts;
}

function findTopLevelBinaryOperator(
  expression: string,
  operators: string[],
  direction: 'left' | 'right' = 'left'
): { index: number; left: string; operator: string; right: string } | null {
  const matches: Array<{ index: number; operator: string }> = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];

    if (quote) {
      if (char === quote && !isEscaped(expression, i)) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth !== 0) continue;

    for (const operator of operators) {
      if (expression.slice(i, i + operator.length) === operator) {
        matches.push({ index: i, operator });
        i += operator.length - 1;
        break;
      }
    }
  }

  if (matches.length === 0) return null;
  const match = direction === 'right' ? matches[matches.length - 1] : matches[0];
  const left = expression.slice(0, match.index).trim();
  const right = expression.slice(match.index + match.operator.length).trim();
  if (!left || !right) return null;
  return { index: match.index, left, operator: match.operator, right };
}

function findTopLevelTernary(
  expression: string
): { condition: string; trueBranch: string; falseBranch: string } | null {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let questionMarkIndex = -1;
  let nestedQuestionMarks = 0;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];

    if (quote) {
      if (char === quote && !isEscaped(expression, i)) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth !== 0) continue;

    if (char === '?') {
      if (questionMarkIndex === -1) {
        questionMarkIndex = i;
      } else {
        nestedQuestionMarks += 1;
      }
      continue;
    }

    if (char === ':' && questionMarkIndex !== -1) {
      if (nestedQuestionMarks > 0) {
        nestedQuestionMarks -= 1;
        continue;
      }

      const condition = expression.slice(0, questionMarkIndex).trim();
      const trueBranch = expression.slice(questionMarkIndex + 1, i).trim();
      const falseBranch = expression.slice(i + 1).trim();

      if (!condition || !trueBranch || !falseBranch) {
        return null;
      }

      return { condition, trueBranch, falseBranch };
    }
  }

  return null;
}

function isBinaryArithmeticOperatorPosition(expression: string, index: number): boolean {
  if (index < 0) return false;
  if (index === 0) return false;

  let previousIndex = index - 1;
  while (previousIndex >= 0 && /\s/.test(expression[previousIndex])) {
    previousIndex -= 1;
  }
  if (previousIndex < 0) return false;

  const previousChar = expression[previousIndex];
  return /[A-Za-z0-9_)\]'"]/.test(previousChar);
}

/**
 * Evaluate a single expression path against the context
 * Supports: state.foo, data.entities, params.id, row.name, item.value, etc.
 * Also supports simple ternary: condition ? trueValue : falseValue
 * Also supports built-in function calls: formatDate(expr)
 */
function evaluatePath(path: string, context: ExpressionContext): unknown {
  const trimmedPath = path.trim();

  // Handle string literals before logical operators and function calls so that
  // hyphens/plus signs inside quoted strings (e.g. 'check-in') are not mistaken
  // for arithmetic operators when the arithmetic block is reached later.
  if (isQuotedLiteral(trimmedPath)) {
    return trimmedPath.slice(1, -1);
  }

  // Handle number literals
  if (/^-?\d+(\.\d+)?$/.test(trimmedPath)) {
    return Number(trimmedPath);
  }

  // Handle boolean literals
  if (trimmedPath === 'true') return true;
  if (trimmedPath === 'false') return false;
  if (trimmedPath === 'null') return null;
  if (trimmedPath === 'undefined') return undefined;

  // Strip matching outer parentheses so that compound sub-expressions like
  // (!a || b) are evaluated as inner expressions rather than as raw paths.
  // Quote state is tracked so that parentheses inside string literals do not
  // affect the depth count.
  if (trimmedPath.startsWith('(') && trimmedPath.endsWith(')')) {
    let depth = 0;
    let matchEnd = -1;
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < trimmedPath.length; i++) {
      const c = trimmedPath[i];
      if (quote) {
        if (c === quote && !isEscaped(trimmedPath, i)) quote = null;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { matchEnd = i; break; }
      }
    }
    if (matchEnd === trimmedPath.length - 1) {
      return evaluatePath(trimmedPath.slice(1, -1), context);
    }
  }

  // Handle ternary expressions: condition ? trueVal : falseVal
  const ternaryMatch = findTopLevelTernary(trimmedPath);
  if (ternaryMatch) {
    const conditionResult = evaluatePath(ternaryMatch.condition, context);
    return conditionResult
      ? evaluatePath(ternaryMatch.trueBranch, context)
      : evaluatePath(ternaryMatch.falseBranch, context);
  }

  // Handle logical OR with JavaScript-like short-circuit semantics.
  // Must run before the function-call regex so that compound expressions like
  // funcA(...) || funcB(...) are split correctly before matching a single call.
  const orParts = splitTopLevel(trimmedPath, '||');
  if (orParts.length > 1) {
    let lastValue: unknown;
    for (const part of orParts) {
      lastValue = evaluatePath(part, context);
      if (lastValue) return lastValue;
    }
    return lastValue;
  }

  // Handle logical AND with JavaScript-like short-circuit semantics.
  // Must run before the function-call regex for the same reason as OR above.
  const andParts = splitTopLevel(trimmedPath, '&&');
  if (andParts.length > 1) {
    let lastValue: unknown;
    for (const part of andParts) {
      lastValue = evaluatePath(part, context);
      if (!lastValue) return lastValue;
    }
    return lastValue;
  }

  // Handle built-in function calls: funcName(arg)
  // Placed after OR/AND so that compound expressions like funcA() && funcB()
  // are not swallowed by the greedy `(.*)` in this regex.
  const funcCallMatch = trimmedPath.match(/^(\w+)\((.*)\)$/);
  if (funcCallMatch) {
    const [, funcName, argsExpr] = funcCallMatch;
    const fn = BUILT_INS[funcName];
    if (typeof fn === 'function') {
      const args = splitFunctionArgs(argsExpr).map((argExpr) =>
        parseValue(argExpr, context)
      );
      return fn(...args, context);
    }
  }

  // Handle simple comparison operators.
  const comparisonMatch = findTopLevelBinaryOperator(
    trimmedPath,
    ['===', '!==', '==', '!=', '>=', '<=', '>', '<']
  );
  if (comparisonMatch) {
    const leftVal = evaluatePath(comparisonMatch.left, context);
    const rightVal = parseValue(comparisonMatch.right, context);

    switch (comparisonMatch.operator) {
      case '==':
      case '===':
        return leftVal === rightVal;
      case '!=':
      case '!==':
        return leftVal !== rightVal;
      case '>':
        return Number(leftVal) > Number(rightVal);
      case '>=':
        return Number(leftVal) >= Number(rightVal);
      case '<':
        return Number(leftVal) < Number(rightVal);
      case '<=':
        return Number(leftVal) <= Number(rightVal);
    }
  }

  // Handle simple arithmetic operators.
  const arithmeticMatch = findTopLevelBinaryOperator(trimmedPath, ['+', '-'], 'right');
  if (
    arithmeticMatch &&
    isBinaryArithmeticOperatorPosition(trimmedPath, arithmeticMatch.index)
  ) {
    const leftVal = parseValue(arithmeticMatch.left, context);
    const rightVal = parseValue(arithmeticMatch.right, context);

    switch (arithmeticMatch.operator) {
      case '+':
        return Number(leftVal) + Number(rightVal);
      case '-':
        return Number(leftVal) - Number(rightVal);
    }
  }

  // Handle negation
  if (trimmedPath.startsWith('!')) {
    return !evaluatePath(trimmedPath.slice(1).trim(), context);
  }

  // Standard path resolution using lodash get
  return get(context, trimmedPath);
}

/**
 * Parse a value that might be a literal or a path
 */
function parseValue(value: string, context: ExpressionContext): unknown {
  const trimmed = value.trim();

  // String literal
  if (isQuotedLiteral(trimmed)) {
    return trimmed.slice(1, -1);
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // Boolean/null literals
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;

  // Otherwise treat as path
  return evaluatePath(trimmed, context);
}

/**
 * Evaluate a single expression string (the content inside {{}})
 */
export function evaluateExpressionContent(
  content: string,
  context: ExpressionContext
): unknown {
  return evaluatePath(content, context);
}

/**
 * Evaluate an expression that may contain {{}} placeholders
 *
 * If the entire value is a single expression like "{{state.count}}",
 * returns the raw value (preserving type).
 *
 * If the value contains embedded expressions like "Hello {{state.name}}!",
 * returns a string with expressions interpolated.
 */
export function evaluateExpression(
  value: unknown,
  context: ExpressionContext
): unknown {
  // Non-string values pass through unchanged
  if (typeof value !== 'string') {
    return value;
  }

  // No expressions - return as-is
  if (!hasExpression(value)) {
    return value;
  }

  // Pure expression - return the raw value (preserves type)
  if (isPureExpression(value)) {
    const content = value.slice(2, -2); // Remove {{ and }}
    return evaluateExpressionContent(content, context);
  }

  // Mixed expression - interpolate into string
  return value.replace(EXPRESSION_PATTERN, (_, content) => {
    const result = evaluateExpressionContent(content, context);
    return result === undefined || result === null ? '' : String(result);
  });
}

/**
 * Recursively resolve all expressions in an object
 */
export function resolveProps(
  props: Record<string, unknown>,
  context: ExpressionContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    resolved[key] = resolveValue(value, context);
  }

  return resolved;
}

/**
 * Resolve a single value (recursively handles objects and arrays)
 */
export function resolveValue(value: unknown, context: ExpressionContext): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return evaluateExpression(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, context));
  }

  if (typeof value === 'object') {
    // Check if it's an action definition (has 'action' property).
    // Eagerly resolve nested string-expression fields so that loop variables
    // (which are only available in the item context at render time) are captured
    // correctly throughout the action payload structure.
    // If a string expression resolves to `undefined`, keep the original template
    // string so it can be re-resolved at dispatch time with the then-current
    // context — this preserves event-driven patterns like
    // `{{event.target.value}}` where `event` is only available when the action fires.
    if ('action' in value) {
      const resolveActionField = (fieldValue: unknown): unknown => {
        if (typeof fieldValue === 'string' && hasExpression(fieldValue)) {
          const resolvedValue = evaluateExpression(fieldValue, context);
          return resolvedValue !== undefined ? resolvedValue : fieldValue;
        }

        if (Array.isArray(fieldValue)) {
          return fieldValue.map((item) => resolveActionField(item));
        }

        if (fieldValue && typeof fieldValue === 'object') {
          const nestedResolved: Record<string, unknown> = {};
          for (const [nestedKey, nestedValue] of Object.entries(fieldValue as Record<string, unknown>)) {
            nestedResolved[nestedKey] = resolveActionField(nestedValue);
          }
          return nestedResolved;
        }

        return fieldValue;
      };

      return resolveActionField(value);
    }

    return resolveProps(value as Record<string, unknown>, context);
  }

  return value;
}

/**
 * Create an expression context with defaults
 */
export function createExpressionContext(
  partial: Partial<ExpressionContext> = {}
): ExpressionContext {
  return {
    state: {},
    data: {},
    params: {},
    ...partial,
  };
}

/**
 * Merge additional context into an existing context
 */
export function mergeContext(
  base: ExpressionContext,
  additional: Partial<ExpressionContext>
): ExpressionContext {
  return {
    ...base,
    ...additional,
    // Merge nested objects properly
    state: { ...base.state, ...(additional.state || {}) },
    data: { ...base.data, ...(additional.data || {}) },
    params: { ...base.params, ...(additional.params || {}) },
  };
}
