import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/auth/AuthContext';
import { canOperate } from '@/auth/types';
import { supabase } from '@/data/supabase';

type WorkflowType = 'checkout' | 'return' | 'inspection';
type ApprovalEventType = 'requisition' | 'delivery' | 'off_rent';
type AssetStatus = 'available' | 'on_rent' | 'returned' | 'inspection_hold' | 'maintenance' | 'in_transit';
type ContractStatus = 'active' | 'draft' | 'closed';
type InspectionType = 'checkout' | 'return' | 'service';
type InspectionOutcome = 'pass' | 'fail';
export type ChecklistItemStatus = 'pass' | 'fail' | 'na' | 'pending';

export interface ChecklistItem {
  key: string;
  label: string;
  section: string;
  required: boolean;
}

export interface ChecklistItemState extends ChecklistItem {
  status: ChecklistItemStatus;
  note: string;
}

export interface ChecklistTemplate {
  categoryPattern: RegExp;
  intent: 'pickup' | 'return' | 'both';
  items: ChecklistItem[];
}

interface ChecklistTemplateRow {
  tenant_id: string | null;
  equipment_category: string | null;
  inspection_intent: 'pickup' | 'return' | 'both' | null;
  item_key: string | null;
  label: string | null;
  section: string | null;
  is_required: boolean | null;
  sort_order: number | null;
}

interface ChecklistDraftItem {
  key: string;
  status: ChecklistItemStatus;
  note: string;
}

interface ChecklistDraftSnapshot {
  categoryName: string;
  intent: 'pickup' | 'return';
  items: ChecklistDraftItem[];
}

export type FieldTask = {
  id: string;
  workflow: WorkflowType;
  contractLineId: string;
  assetId: string;
  contractId: string;
  contractLabel: string;
  assetName: string;
  assetCategoryName: string;
  customerName: string;
  jobSiteName: string;
  timeLabel: string;
  assetStatus: AssetStatus;
  contractStatus: ContractStatus;
  inspectionType: InspectionType;
  downtimeMinutes: number;
  assignmentData: AssignmentData;
  projectContextId: string;
  costCode: string;
  lineData: Record<string, unknown>;
  assetState: Record<string, unknown>;
};

type ContractData = {
  order_id?: string;
  project_context_id?: string;
  project_id?: string;
  cost_code?: string;
};

type ContractRow = {
  entity_id: string;
  status: string | null;
  contract_number?: string | null;
  data?: ContractData | null;
};

type OrderData = {
  customer_id?: string;
  job_site_id?: string;
  project_context_id?: string;
  project_id?: string;
  cost_code?: string;
};

type AssetLookupRow = {
  asset_id: string;
  name?: string | null;
  status?: string | null;
  category_id?: string | null;
  state?: Record<string, unknown> | null;
};

type CategoryRow = {
  entity_id: string;
  name: string | null;
};

type LineData = {
  planned_start?: string;
  planned_end?: string;
  downtime_minutes?: number;
  field_operator_id?: string;
  assigned_operator_id?: string;
  assigned_to?: string;
  operator_id?: string;
  created_by?: string;
  project_context_id?: string;
  project_id?: string;
  cost_code?: string;
  resulting_asset_status?: string;
  asset_name_snapshot?: string;
};

const ASSIGNMENT_FIELD_KEYS = [
  'field_operator_id',
  'assigned_operator_id',
  'assigned_to',
  'operator_id',
  'created_by',
] as const;
type AssignmentFieldKey = (typeof ASSIGNMENT_FIELD_KEYS)[number];
type AssignmentData = Partial<Record<AssignmentFieldKey, string>>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const GEOLOCATION_PERMISSION_DENIED = 1;
const LOCATION_DECIMAL_PLACES = 5;
const LOCATION_TIMEOUT_MS = 10_000;
const DEFAULT_METER_UNIT = 'hours';
const UUID_SEARCH_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const WORKFLOWS_WITH_LINE_STATE: WorkflowType[] = ['checkout', 'return', 'inspection'];
const CHECKLIST_DRAFT_STORAGE_KEY = 'field-mobile-checklist-drafts';

export const CHECKLIST_TEMPLATES: ChecklistTemplate[] = [
  {
    categoryPattern: /excavat/i,
    intent: 'both',
    items: [
      { key: 'engine_oil', label: 'Engine oil level within range', section: 'Fluid Levels', required: true },
      { key: 'hydraulic_fluid', label: 'Hydraulic fluid level within range', section: 'Fluid Levels', required: true },
      { key: 'coolant_level', label: 'Coolant level within range', section: 'Fluid Levels', required: true },
      { key: 'track_condition', label: 'Tracks in serviceable condition (no cracks, missing pads)', section: 'Undercarriage', required: true },
      { key: 'bucket_teeth', label: 'Bucket teeth / cutting edge acceptable', section: 'Attachments', required: false },
      { key: 'body_damage', label: 'No new body damage visible', section: 'Exterior', required: true },
      { key: 'cab_glass', label: 'Cab glass intact', section: 'Cab', required: true },
      { key: 'emergency_stop', label: 'Emergency stop operational', section: 'Safety', required: true },
      { key: 'fire_extinguisher', label: 'Fire extinguisher present and charged', section: 'Safety', required: true },
      { key: 'seat_belt', label: 'Seat belt functional', section: 'Safety', required: true },
      { key: 'gauges', label: 'All gauges/warning lights normal', section: 'Cab', required: true },
    ],
  },
  {
    categoryPattern: /forklift|lift truck|reach truck/i,
    intent: 'both',
    items: [
      { key: 'fork_blades', label: 'Fork blades straight with no visible cracks', section: 'Forks', required: true },
      { key: 'fork_heel', label: 'Fork heel thickness within spec', section: 'Forks', required: false },
      { key: 'carriage', label: 'Carriage and backrest intact', section: 'Forks', required: true },
      { key: 'hydraulic_fluid', label: 'Hydraulic fluid level within range', section: 'Fluid Levels', required: true },
      { key: 'engine_oil', label: 'Engine oil level within range', section: 'Fluid Levels', required: true },
      { key: 'tire_condition', label: 'Tires in serviceable condition', section: 'Tyres', required: true },
      { key: 'horn', label: 'Horn operational', section: 'Safety', required: true },
      { key: 'lights', label: 'All lights operational', section: 'Safety', required: true },
      { key: 'seat_belt', label: 'Seat belt / operator restraint functional', section: 'Safety', required: true },
      { key: 'overhead_guard', label: 'Overhead guard in place and undamaged', section: 'Safety', required: true },
      { key: 'fire_extinguisher', label: 'Fire extinguisher present and charged', section: 'Safety', required: true },
      { key: 'no_body_damage', label: 'No new body damage visible', section: 'Exterior', required: true },
    ],
  },
  {
    categoryPattern: /crane|hoist/i,
    intent: 'both',
    items: [
      { key: 'wire_rope', label: 'Wire rope in serviceable condition (no kinks, breaks)', section: 'Rigging', required: true },
      { key: 'hook_block', label: 'Hook and block in good condition, latch operational', section: 'Rigging', required: true },
      { key: 'boom_condition', label: 'Boom sections undamaged', section: 'Structural', required: true },
      { key: 'outrigger_pads', label: 'Outrigger pads present', section: 'Stability', required: true },
      { key: 'load_chart', label: 'Load chart legible and in cab', section: 'Documentation', required: true },
      { key: 'safety_devices', label: 'All limit switches and safety devices functional', section: 'Safety', required: true },
      { key: 'engine_oil', label: 'Engine oil level within range', section: 'Fluid Levels', required: true },
      { key: 'hydraulic_fluid', label: 'Hydraulic fluid level within range', section: 'Fluid Levels', required: true },
      { key: 'no_body_damage', label: 'No new structural damage visible', section: 'Structural', required: true },
    ],
  },
  {
    categoryPattern: /aerial|awp|boom lift|scissor lift|mewp/i,
    intent: 'both',
    items: [
      { key: 'platform_condition', label: 'Platform/basket in undamaged condition', section: 'Platform', required: true },
      { key: 'harness_points', label: 'Harness anchor points undamaged', section: 'Platform', required: true },
      { key: 'controls', label: 'Ground and platform controls operational', section: 'Controls', required: true },
      { key: 'battery_level', label: 'Battery level adequate for work', section: 'Power', required: true },
      { key: 'hydraulic_fluid', label: 'Hydraulic fluid level within range', section: 'Fluid Levels', required: true },
      { key: 'outriggers', label: 'Outriggers / stabilisers functional', section: 'Stability', required: true },
      { key: 'emergency_descent', label: 'Emergency descent operational', section: 'Safety', required: true },
      { key: 'no_body_damage', label: 'No new structural damage visible', section: 'Exterior', required: true },
      { key: 'warning_lights', label: 'Flashing/warning lights operational', section: 'Safety', required: false },
    ],
  },
  {
    categoryPattern: /compressor/i,
    intent: 'both',
    items: [
      { key: 'engine_oil', label: 'Engine oil level within range', section: 'Fluid Levels', required: true },
      { key: 'compressor_oil', label: 'Compressor oil level within range', section: 'Fluid Levels', required: true },
      { key: 'air_filter', label: 'Air filter clean / within service interval', section: 'Filters', required: true },
      { key: 'belt_tension', label: 'Drive belt tension correct', section: 'Drive', required: false },
      { key: 'safety_relief', label: 'Safety relief valve present and tagged', section: 'Safety', required: true },
      { key: 'pressure_gauge', label: 'Pressure gauge readable and accurate', section: 'Safety', required: true },
      { key: 'hoses', label: 'Air hoses in serviceable condition', section: 'Hoses', required: true },
      { key: 'no_body_damage', label: 'No new body damage visible', section: 'Exterior', required: true },
    ],
  },
  {
    categoryPattern: /generator/i,
    intent: 'both',
    items: [
      { key: 'engine_oil', label: 'Engine oil level within range', section: 'Fluid Levels', required: true },
      { key: 'coolant_level', label: 'Coolant level within range', section: 'Fluid Levels', required: true },
      { key: 'battery_charge', label: 'Battery charge adequate for start', section: 'Electrical', required: true },
      { key: 'belts', label: 'Belts in serviceable condition', section: 'Drive', required: false },
      { key: 'earth_cable', label: 'Earth / grounding cable present', section: 'Electrical', required: true },
      { key: 'output_voltage', label: 'Output voltage correct at no load', section: 'Electrical', required: true },
      { key: 'no_body_damage', label: 'No new body damage visible', section: 'Exterior', required: true },
    ],
  },
  {
    categoryPattern: /telehandler|telescopic handler/i,
    intent: 'both',
    items: [
      { key: 'engine_oil', label: 'Engine oil level within range', section: 'Fluid Levels', required: true },
      { key: 'hydraulic_fluid', label: 'Hydraulic fluid level within range', section: 'Fluid Levels', required: true },
      { key: 'coolant_level', label: 'Coolant level within range', section: 'Fluid Levels', required: true },
      { key: 'tyres', label: 'Tyre condition and pressure acceptable', section: 'Tyres', required: true },
      { key: 'forks_attachment', label: 'Forks / attachment in serviceable condition', section: 'Attachments', required: true },
      { key: 'load_chart', label: 'Load chart present and legible', section: 'Documentation', required: true },
      { key: 'seat_belt', label: 'Seat belt functional', section: 'Safety', required: true },
      { key: 'no_body_damage', label: 'No new body damage visible', section: 'Exterior', required: true },
    ],
  },
  {
    categoryPattern: /skid.?steer|compact track loader|ctl/i,
    intent: 'both',
    items: [
      { key: 'engine_oil', label: 'Engine oil level within range', section: 'Fluid Levels', required: true },
      { key: 'hydraulic_fluid', label: 'Hydraulic fluid level within range', section: 'Fluid Levels', required: true },
      { key: 'chain_tension', label: 'Drive chain / track tension correct', section: 'Drive', required: true },
      { key: 'bucket_cutting_edge', label: 'Bucket cutting edge acceptable', section: 'Attachments', required: false },
      { key: 'seat_bar', label: 'Seat bar / restraint operational', section: 'Safety', required: true },
      { key: 'no_body_damage', label: 'No new body damage visible', section: 'Exterior', required: true },
    ],
  },
  {
    categoryPattern: /.*/,
    intent: 'both',
    items: [
      { key: 'general_condition', label: 'General condition acceptable', section: 'General', required: true },
      { key: 'no_visible_leaks', label: 'No visible fluid leaks', section: 'General', required: true },
      { key: 'no_body_damage', label: 'No new body damage visible', section: 'Exterior', required: true },
      { key: 'safety_devices', label: 'Safety devices present and functional', section: 'Safety', required: true },
      { key: 'documentation', label: 'Relevant documentation present (manuals, inspection tags)', section: 'Documentation', required: false },
    ],
  },
];

export function applyChecklistTemplate(
  categoryName: string,
  intent: 'pickup' | 'return',
  tenantItems: ChecklistItem[] = []
): ChecklistItemState[] {
  const normalised = categoryName.trim();
  const template = CHECKLIST_TEMPLATES.find(
    (t) => t.categoryPattern.test(normalised) && (t.intent === 'both' || t.intent === intent)
  ) ?? CHECKLIST_TEMPLATES[CHECKLIST_TEMPLATES.length - 1];

  const baseItems = template.items;
  const tenantItemsByKey = new Map(tenantItems.map((item) => [item.key, item]));
  const merged = baseItems.map((item) => tenantItemsByKey.get(item.key) ?? item);
  for (const tenant of tenantItems) {
    if (!baseItems.some((item) => item.key === tenant.key)) {
      merged.push(tenant);
    }
  }

  return merged.map((item) => ({ ...item, status: 'pending' as ChecklistItemStatus, note: '' }));
}

function getChecklistDraftStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readChecklistDraftSnapshots(): Record<string, ChecklistDraftSnapshot> {
  const storage = getChecklistDraftStorage();
  if (!storage) {
    return {};
  }

  try {
    const rawValue = storage.getItem(CHECKLIST_DRAFT_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, ChecklistDraftSnapshot>;
  } catch {
    return {};
  }
}

function writeChecklistDraftSnapshot(taskId: string, snapshot: ChecklistDraftSnapshot) {
  const storage = getChecklistDraftStorage();
  if (!storage) {
    return;
  }

  const snapshots = readChecklistDraftSnapshots();
  snapshots[taskId] = snapshot;
  storage.setItem(CHECKLIST_DRAFT_STORAGE_KEY, JSON.stringify(snapshots));
}

function clearChecklistDraftSnapshot(taskId: string) {
  const storage = getChecklistDraftStorage();
  if (!storage) {
    return;
  }

  const snapshots = readChecklistDraftSnapshots();
  if (!(taskId in snapshots)) {
    return;
  }
  delete snapshots[taskId];
  storage.setItem(CHECKLIST_DRAFT_STORAGE_KEY, JSON.stringify(snapshots));
}

function restoreChecklistTemplate(
  taskId: string,
  categoryName: string,
  intent: 'pickup' | 'return',
  tenantItems: ChecklistItem[] = []
): ChecklistItemState[] {
  const templateItems = applyChecklistTemplate(categoryName, intent, tenantItems);
  const snapshot = readChecklistDraftSnapshots()[taskId];
  if (!snapshot || snapshot.categoryName !== categoryName || snapshot.intent !== intent) {
    return templateItems;
  }

  return templateItems.map((item) => {
    const draftedItem = snapshot.items.find((draft) => draft.key === item.key);
    return draftedItem ? { ...item, status: draftedItem.status, note: draftedItem.note } : item;
  });
}

function matchesChecklistTemplateCategory(templateCategory: string | null, categoryName: string): boolean {
  if (!templateCategory) {
    return false;
  }
  const normalisedTemplateCategory = templateCategory.trim().toLowerCase();
  return normalisedTemplateCategory === '*' || normalisedTemplateCategory === categoryName.trim().toLowerCase();
}

async function loadChecklistTemplateItems(
  categoryName: string,
  intent: 'pickup' | 'return'
): Promise<ChecklistItem[]> {
  const { data, error } = await supabase
    .from('v_checklist_template_items')
    .select('tenant_id,equipment_category,inspection_intent,item_key,label,section,is_required,sort_order');

  if (error) {
    throw new Error(error.message);
  }

  const rows = ((data ?? []) as ChecklistTemplateRow[])
    .filter(
      (row) =>
        matchesChecklistTemplateCategory(row.equipment_category, categoryName) &&
        (row.inspection_intent === 'both' || row.inspection_intent === intent) &&
        typeof row.item_key === 'string' &&
        row.item_key.trim() !== '' &&
        typeof row.label === 'string' &&
        row.label.trim() !== ''
    )
    .sort(
      (left, right) =>
        Number(Boolean(right.tenant_id)) - Number(Boolean(left.tenant_id)) ||
        Number((right.equipment_category ?? '').trim() !== '*') - Number((left.equipment_category ?? '').trim() !== '*') ||
        (left.sort_order ?? 0) - (right.sort_order ?? 0) ||
        (left.item_key ?? '').localeCompare(right.item_key ?? '')
    );

  const mergedItems = new Map<string, ChecklistItem>();
  for (const row of rows) {
    const key = row.item_key!.trim();
    if (mergedItems.has(key)) {
      continue;
    }
    mergedItems.set(key, {
      key,
      label: row.label!.trim(),
      section: row.section?.trim() || 'General',
      required: Boolean(row.is_required),
    });
  }

  return Array.from(mergedItems.values());
}



export interface InventorySummary {
  total: number;
  available: number;
  on_rent: number;
  returned: number;
  inspection_hold: number;
  maintenance: number;
  in_transit: number;
}

export interface FieldWorkflowState {
  workflow: WorkflowType;
  assetStatus: AssetStatus;
  contractStatus: ContractStatus;
  downtimeMinutes: number;
  inspectionType: InspectionType;
  inspectionOutcome: InspectionOutcome;
}

export interface FieldWorkflowEvaluation {
  blockedReasons: string[];
  finalAssetStatus: AssetStatus;
}

export interface ReturnSessionContext {
  contractId: string;
  customerName: string;
  jobSiteName: string;
}

export interface ReturnScanResult {
  candidates: FieldTask[];
  resolvedAssetId: string;
}

export interface ReturnCandidateSelection {
  task: FieldTask | null;
  isContextMatch: boolean;
  requiresDisambiguation: boolean;
}

const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  available: 'Available',
  on_rent: 'On rent',
  returned: 'Returned',
  inspection_hold: 'Inspection hold',
  maintenance: 'Maintenance',
  in_transit: 'In transit',
};

function normalizeAssetStatus(status: string | null | undefined): AssetStatus {
  if (!status) return 'available';
  if (status === 'on_inspection_hold') return 'inspection_hold';
  if (status === 'inspection_hold') return 'inspection_hold';
  if (status === 'on_rent') return 'on_rent';
  if (status === 'returned') return 'returned';
  if (status === 'maintenance') return 'maintenance';
  if (status === 'in_transit') return 'in_transit';
  return 'available';
}

function normalizeContractStatus(status: string | null | undefined): ContractStatus {
  if (status === 'active') return 'active';
  if (status === 'closed') return 'closed';
  return 'draft';
}

function toDbAssetStatus(status: AssetStatus): string {
  return status === 'inspection_hold' ? 'on_inspection_hold' : status;
}

function toWorkflow(contractLineStatus: string | null | undefined): WorkflowType | null {
  if (contractLineStatus === 'pending') return 'checkout';
  if (contractLineStatus === 'checked_out') return 'return';
  if (contractLineStatus === 'returned') return 'inspection';
  return null;
}

function inferAssetStatusFallback(workflow: WorkflowType, lineData: LineData | null | undefined): AssetStatus {
  const resultingAssetStatus = firstString(lineData?.resulting_asset_status);
  if (resultingAssetStatus) {
    return normalizeAssetStatus(resultingAssetStatus);
  }
  if (workflow === 'return') return 'on_rent';
  if (workflow === 'inspection') return 'returned';
  return 'available';
}

function resolveTaskAssetStatus(
  workflow: WorkflowType,
  assetStatus: string | null | undefined,
  lineData: LineData | null | undefined
): AssetStatus {
  const persistedResultingStatus = firstString(lineData?.resulting_asset_status);
  if (workflow === 'inspection' && persistedResultingStatus) {
    return normalizeAssetStatus(persistedResultingStatus);
  }
  if (assetStatus) {
    return normalizeAssetStatus(assetStatus);
  }
  return inferAssetStatusFallback(workflow, lineData);
}

function toDateLabel(isoLikeValue: string | null | undefined, fallback: string): string {
  if (!isoLikeValue) return fallback;
  const date = new Date(isoLikeValue);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date.toLocaleString();
}

function toApprovalEventType(workflow: WorkflowType): ApprovalEventType {
  if (workflow === 'checkout') return 'delivery';
  if (workflow === 'return') return 'off_rent';
  return 'requisition';
}

function sanitizeUploadFilename(fileName: string): string {
  const withoutPath = fileName.split('/').pop()?.split('\\').pop() || 'photo';
  const dotIndex = withoutPath.lastIndexOf('.');
  const rawBaseName = dotIndex > 0 ? withoutPath.slice(0, dotIndex) : withoutPath;
  const rawExtension = dotIndex > 0 ? withoutPath.slice(dotIndex + 1) : '';
  const baseName = rawBaseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'photo';
  const extension = rawExtension.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return extension ? `${baseName}.${extension}` : baseName;
}

function sanitizeStoragePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function createUploadKeyPrefix(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toIsoFromDateTimeLocal(dateTimeLocal: string): string | null {
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(dateTimeLocal);
  if (!localMatch) {
    return null;
  }
  const [, year, month, day, hour, minute] = localMatch;
  const localDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (Number.isNaN(localDate.getTime())) {
    return null;
  }
  return localDate.toISOString();
}

function extractAssetIdFromScan(scanValue: string): string | null {
  return scanValue.match(UUID_SEARCH_PATTERN)?.[0] ?? null;
}

export async function resolveQuickOrderTask(
  scanValue: string,
  tasks: FieldTask[],
  supabaseClient: Pick<typeof supabase, 'from'> = supabase
): Promise<FieldTask | 'ambiguous' | null> {
  const trimmedScan = scanValue.trim();
  if (!trimmedScan) {
    return null;
  }

  const checkoutTasks = tasks.filter((task) => task.workflow === 'checkout');
  if (checkoutTasks.length === 0) {
    return null;
  }

  const resolvedAssetId = extractAssetIdFromScan(trimmedScan);
  if (resolvedAssetId) {
    return checkoutTasks.find((task) => task.assetId === resolvedAssetId) ?? null;
  }

  const normalizedScan = trimmedScan.toLowerCase();
  const textMatches = checkoutTasks.filter(
    (task) =>
      task.assetName.toLowerCase().includes(normalizedScan) ||
      task.contractLabel.toLowerCase().includes(normalizedScan)
  );
  if (textMatches.length > 1) {
    return 'ambiguous';
  }
  if (textMatches.length === 1) {
    return textMatches[0];
  }

  const { data, error } = await supabaseClient.from('v_current_assets').select('asset_id').eq('serial_number', trimmedScan);
  if (error) {
    throw error;
  }
  const assetRows = (data ?? []) as AssetLookupRow[];
  const assetId = assetRows[0]?.asset_id ?? '';
  if (!assetId) {
    return null;
  }

  return checkoutTasks.find((task) => task.assetId === assetId) ?? null;
}

function firstString(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

async function resolveInventoryAdjustmentAssetId(manualAssetId: string, scanValue: string): Promise<string> {
  const trimmedAssetId = manualAssetId.trim();
  if (trimmedAssetId) {
    return trimmedAssetId;
  }

  const trimmedScanValue = scanValue.trim();
  if (!trimmedScanValue) {
    return '';
  }

  const scannedAssetId = extractAssetIdFromScan(trimmedScanValue);
  if (scannedAssetId) {
    return scannedAssetId;
  }

  const { data, error } = await supabase.from('v_current_assets').select('asset_id').eq('serial_number', trimmedScanValue);
  if (error) {
    throw error;
  }
  const assetRows = (data ?? []) as AssetLookupRow[];
  return assetRows[0]?.asset_id ?? '';
}

export async function resolveReturnScanCandidates(
  scanValue: string,
  returnTasks: FieldTask[]
): Promise<ReturnScanResult> {
  const trimmedScan = scanValue.trim();
  if (!trimmedScan) {
    return { candidates: [], resolvedAssetId: '' };
  }

  let resolvedAssetId = extractAssetIdFromScan(trimmedScan) ?? '';

  if (!resolvedAssetId) {
    const { data, error } = await supabase
      .from('v_current_assets')
      .select('asset_id')
      .eq('serial_number', trimmedScan);
    if (error) throw error;
    const assetRows = (data ?? []) as AssetLookupRow[];
    resolvedAssetId = assetRows[0]?.asset_id ?? '';
  }

  if (!resolvedAssetId) {
    return { candidates: [], resolvedAssetId: '' };
  }

  const candidates = returnTasks.filter((task) => task.assetId === resolvedAssetId);
  return { candidates, resolvedAssetId };
}

export function selectReturnCandidateWithContext(
  candidates: FieldTask[],
  sessionContext: ReturnSessionContext | null
): ReturnCandidateSelection {
  if (candidates.length === 0) {
    return { task: null, isContextMatch: false, requiresDisambiguation: false };
  }

  if (candidates.length === 1) {
    const task = candidates[0];
    const isContextMatch = !sessionContext || task.contractId === sessionContext.contractId;
    return { task, isContextMatch, requiresDisambiguation: false };
  }

  if (sessionContext) {
    const contextMatches = candidates.filter((t) => t.contractId === sessionContext.contractId);
    if (contextMatches.length === 1) {
      return { task: contextMatches[0], isContextMatch: true, requiresDisambiguation: false };
    }
  }

  return { task: null, isContextMatch: false, requiresDisambiguation: true };
}

export function evaluateFieldWorkflow(state: FieldWorkflowState): FieldWorkflowEvaluation {
  const blockedReasons: string[] = [];
  const isDowntimeOpen = state.downtimeMinutes > 0;
  const downtimeReason = 'Asset has active downtime. Complete maintenance before field execution.';
  let finalAssetStatus: AssetStatus = state.assetStatus;

  if (state.workflow === 'checkout') {
    if (state.assetStatus !== 'available') {
      blockedReasons.push(
        state.assetStatus === 'inspection_hold'
          ? 'Checkout blocked: asset is on inspection_hold. Pass inspection or open maintenance first.'
          : `Checkout blocked: asset must be available, current state is ${state.assetStatus}.`
      );
    }
    if (state.contractStatus !== 'active') {
      blockedReasons.push('Checkout blocked: contract must be active before on-hire.');
    }
    if (isDowntimeOpen) {
      blockedReasons.push(downtimeReason);
    }
    finalAssetStatus = blockedReasons.length === 0 ? 'on_rent' : state.assetStatus;
  }

  if (state.workflow === 'return') {
    if (state.assetStatus !== 'on_rent') {
      blockedReasons.push(`Return blocked: asset must be on_rent, current state is ${state.assetStatus}.`);
    }
    if (state.contractStatus !== 'active') {
      blockedReasons.push('Return blocked: contract must remain active until check-in is completed.');
    }
    finalAssetStatus = blockedReasons.length === 0 ? 'returned' : state.assetStatus;
  }

  if (state.workflow === 'inspection') {
    if (isDowntimeOpen && state.inspectionOutcome === 'pass') {
      blockedReasons.push(downtimeReason);
    }
    if (state.inspectionOutcome === 'fail') {
      finalAssetStatus = 'inspection_hold';
    } else if (state.inspectionType === 'checkout') {
      finalAssetStatus = 'on_rent';
    } else {
      finalAssetStatus = 'available';
    }
  }

  return { blockedReasons, finalAssetStatus };
}

function assignmentFilterForFieldOperator(fieldOperatorId: string): string {
  if (!UUID_PATTERN.test(fieldOperatorId)) {
    return '';
  }

  return ASSIGNMENT_FIELD_KEYS.map((key) => `data->>${key}.eq.${fieldOperatorId}`).join(',');
}

function isAssignedToFieldOperator(lineData: LineData | null | undefined, fieldOperatorId: string): boolean {
  if (!lineData) return false;
  return ASSIGNMENT_FIELD_KEYS.map((key) => lineData[key]).includes(fieldOperatorId);
}

function extractAssignmentData(lineData: LineData | null | undefined): AssignmentData {
  const assignmentData: AssignmentData = {};
  if (!lineData) {
    return assignmentData;
  }

  for (const key of ASSIGNMENT_FIELD_KEYS) {
    const value = lineData[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      assignmentData[key] = value;
    }
  }

  return assignmentData;
}

export async function loadInventorySummary(): Promise<InventorySummary> {
  const { data, error } = await supabase.from('v_current_assets').select('asset_id,status');

  if (error) {
    throw error;
  }

  const rows = data ?? [];
  const summary: InventorySummary = {
    total: rows.length,
    available: 0,
    on_rent: 0,
    returned: 0,
    inspection_hold: 0,
    maintenance: 0,
    in_transit: 0,
  };

  for (const row of rows) {
    // normalizeAssetStatus maps any unknown DB value to 'available', so the
    // key access below is always safe against future DB status additions.
    const status = normalizeAssetStatus(row.status as string | null);
    summary[status] += 1;
  }

  return summary;
}

async function loadFieldTasks(fieldOperatorId: string | null): Promise<FieldTask[]> {
  if (!fieldOperatorId) {
    return [];
  }

  const assignmentFilter = assignmentFilterForFieldOperator(fieldOperatorId);
  if (!assignmentFilter) {
    return [];
  }

  const lineQuery = supabase
    .from('v_rental_contract_line_current')
    .select('entity_id,status,contract_id,asset_id,actual_start,actual_end,data')
    .or(assignmentFilter);

  const { data: lineRows, error: lineError } = await lineQuery;

  if (lineError) {
    throw lineError;
  }

  const actionableLines = (lineRows ?? []).filter((line) => {
    const workflow = toWorkflow(line.status);
    if (!workflow) return false;
    const lineData = (line.data as LineData | null) ?? null;
    return isAssignedToFieldOperator(lineData, fieldOperatorId);
  });

  if (actionableLines.length === 0) {
    return [];
  }

  const contractIds = Array.from(new Set(actionableLines.map((line) => line.contract_id).filter(Boolean)));
  const assetIds = Array.from(new Set(actionableLines.map((line) => line.asset_id).filter(Boolean)));

  const { data: assetRows } = assetIds.length
    ? await supabase.from('v_current_assets').select('asset_id,name,status,state,category_id').in('asset_id', assetIds)
    : { data: [] };

  const categoryIds = Array.from(
    new Set(
      (assetRows ?? [])
        .map((asset) => (asset as AssetLookupRow).category_id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    )
  );

  const { data: categoryRows } = categoryIds.length
    ? await supabase.from('rental_current_asset_categories').select('entity_id,name').in('entity_id', categoryIds)
    : { data: [] };

  const categoryMap = new Map((categoryRows ?? []).map((c) => [c.entity_id, c as CategoryRow]));

  const { data: contractRows } = contractIds.length
    ? await supabase
        .from('v_rental_contract_current')
        .select('entity_id,status,contract_number,data')
        .in('entity_id', contractIds)
    : { data: [] };

  const contractMap = new Map<string, ContractRow>(
    (contractRows ?? []).map((contract) => {
      const contractRow = contract as ContractRow;
      return [contractRow.entity_id, contractRow];
    })
  );
  const orderIds = Array.from(
    new Set(
      (contractRows ?? [])
        .map((contract) => (contract.data as ContractData | null)?.order_id)
        .filter(Boolean)
    )
  );

  const { data: orderRows } = orderIds.length
    ? await supabase.from('v_rental_order_current').select('entity_id,status,data').in('entity_id', orderIds)
    : { data: [] };

  const orderMap = new Map((orderRows ?? []).map((order) => [order.entity_id, order]));
  const customerIds = Array.from(
    new Set(
      (orderRows ?? [])
        .map((order) => (order.data as Record<string, string> | null)?.customer_id)
        .filter(Boolean)
    )
  );
  const jobSiteIds = Array.from(
    new Set(
      (orderRows ?? [])
        .map((order) => (order.data as Record<string, string> | null)?.job_site_id)
        .filter(Boolean)
    )
  );

  const { data: customerRows } = customerIds.length
    ? await supabase.from('rental_current_customers').select('entity_id,name').in('entity_id', customerIds)
    : { data: [] };

  const { data: jobSiteRows } = jobSiteIds.length
    ? await supabase.from('rental_current_job_sites').select('entity_id,name').in('entity_id', jobSiteIds)
    : { data: [] };

  const assetMap = new Map((assetRows ?? []).map((asset) => [asset.asset_id, asset]));
  const customerMap = new Map((customerRows ?? []).map((customer) => [customer.entity_id, customer]));
  const jobSiteMap = new Map((jobSiteRows ?? []).map((jobSite) => [jobSite.entity_id, jobSite]));

  return actionableLines.flatMap<FieldTask>((line) => {
      const workflow = toWorkflow(line.status);
      if (!workflow) return [];

      const asset = assetMap.get(line.asset_id);
      const assetCategoryId = asset?.category_id ?? null;
      const assetCategoryName = assetCategoryId ? (categoryMap.get(assetCategoryId)?.name ?? '') : '';
      const contract = contractMap.get(line.contract_id);
      const orderId = (contract?.data as ContractData | null)?.order_id;
      const contractNumber = contract?.contract_number ?? null;
      const order = orderMap.get(orderId ?? '');
      const customerId = (order?.data as OrderData | null)?.customer_id;
      const jobSiteId = (order?.data as OrderData | null)?.job_site_id;
      const customer = customerMap.get(customerId ?? '');
      const jobSite = jobSiteMap.get(jobSiteId ?? '');

      const lineData = (line.data as LineData | null) ?? null;
      const persistedAssetName = firstString(lineData?.asset_name_snapshot);
      const plannedStart = lineData?.planned_start;
      const plannedEnd = lineData?.planned_end;
      const projectContextId = firstString(
        lineData?.project_context_id,
        lineData?.project_id,
        (order?.data as OrderData | null)?.project_context_id,
        (order?.data as OrderData | null)?.project_id,
        (contract?.data as ContractData | null)?.project_context_id,
        (contract?.data as ContractData | null)?.project_id,
        jobSiteId
      );
      const costCode = firstString(
        lineData?.cost_code,
        (order?.data as OrderData | null)?.cost_code,
        (contract?.data as ContractData | null)?.cost_code
      );

      return [{
        id: `${workflow}:${line.entity_id}`,
        workflow,
        contractLineId: line.entity_id,
        assetId: line.asset_id,
        contractId: line.contract_id,
        contractLabel: contractNumber || line.contract_id,
        assetName: firstString(asset?.name, persistedAssetName, line.asset_id),
        assetCategoryName,
        customerName: customer?.name || 'Customer unavailable',
        jobSiteName: jobSite?.name || 'Job site unavailable',
        timeLabel:
          workflow === 'checkout'
            ? toDateLabel(plannedStart, 'Checkout date not scheduled')
            : workflow === 'return'
              ? toDateLabel(plannedEnd, 'Pickup date not scheduled')
              : toDateLabel(line.actual_end, 'Inspection pending now'),
        assetStatus: resolveTaskAssetStatus(workflow, asset?.status, lineData),
        contractStatus: normalizeContractStatus(contract?.status),
        inspectionType: workflow === 'checkout' ? 'checkout' : 'return',
        downtimeMinutes: Number(lineData?.downtime_minutes) || 0,
        assignmentData: extractAssignmentData(lineData),
        projectContextId,
        costCode,
        lineData: { ...(lineData ?? {}) },
        assetState: { ...(asset?.state ?? {}) },
      } satisfies FieldTask];
    });
}

export const Route = createFileRoute('/field/mobile')({
  component: MobileFieldWorkflowScreen,
});

export function MobileFieldWorkflowScreen() {
  const { profile } = useAuth();
  const [tasks, setTasks] = useState<FieldTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [inventorySummary, setInventorySummary] = useState<InventorySummary | null>(null);
  const [inventoryLoadError, setInventoryLoadError] = useState<string | null>(null);
  const [adjustAssetId, setAdjustAssetId] = useState('');
  const [adjustScanValue, setAdjustScanValue] = useState('');
  const [adjustStatus, setAdjustStatus] = useState<AssetStatus>('available');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustPhotoFiles, setAdjustPhotoFiles] = useState<File[]>([]);
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [adjustSummary, setAdjustSummary] = useState<string | null>(null);

  const [quickScan, setQuickScan] = useState('');
  const [quickTask, setQuickTask] = useState<FieldTask | null>(null);
  const [quickScanStatus, setQuickScanStatus] = useState<string | null>(null);
  const [isQuickResolving, setIsQuickResolving] = useState(false);
  const [quickDriver, setQuickDriver] = useState('');
  const [quickTruck, setQuickTruck] = useState('');
  const [quickDeparture, setQuickDeparture] = useState('');
  const [quickDriverSignature, setQuickDriverSignature] = useState('');
  const [quickSignature, setQuickSignature] = useState('');
  const [quickSubmissionSummary, setQuickSubmissionSummary] = useState<string | null>(null);
  const [isQuickSubmitting, setIsQuickSubmitting] = useState(false);

  const [signature, setSignature] = useState('');
  const [captureSignatureConsent, setCaptureSignatureConsent] = useState(false);
  const [assignedDriver, setAssignedDriver] = useState('');
  const [assignedTruck, setAssignedTruck] = useState('');
  const [departureTimestamp, setDepartureTimestamp] = useState('');
  const [driverSignature, setDriverSignature] = useState('');
  const [approvalEventType, setApprovalEventType] = useState<ApprovalEventType>('delivery');
  const [projectContextId, setProjectContextId] = useState('');
  const [costCode, setCostCode] = useState('');
  const [notes, setNotes] = useState('');
  const [meterReading, setMeterReading] = useState('');
  const [fuelLevel, setFuelLevel] = useState('');
  const [inspectionOutcome, setInspectionOutcome] = useState<InspectionOutcome>('pass');
  const [inspectionType, setInspectionType] = useState<InspectionType>('return');
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [location, setLocation] = useState<string>('Not captured');
  const [locationStatus, setLocationStatus] = useState<string>('Location capture optional');
  const [submissionSummary, setSubmissionSummary] = useState<string | null>(null);
  const [checklistItems, setChecklistItems] = useState<ChecklistItemState[]>([]);

  const [quickReturnScan, setQuickReturnScan] = useState('');
  const [quickReturnCandidates, setQuickReturnCandidates] = useState<FieldTask[]>([]);
  const [quickReturnSelectedCandidateId, setQuickReturnSelectedCandidateId] = useState<string | null>(null);
  const [quickReturnError, setQuickReturnError] = useState<string | null>(null);
  const [quickReturnIsResolving, setQuickReturnIsResolving] = useState(false);
  const [quickReturnSessionContext, setQuickReturnSessionContext] = useState<ReturnSessionContext | null>(null);
  const [quickReturnContextConflict, setQuickReturnContextConflict] = useState<FieldTask | null>(null);

  // Clear session context when no return tasks remain (end of unload session), including when tasks is empty.
  useEffect(() => {
    const hasReturnTasks = tasks.some((t) => t.workflow === 'return');
    if (!hasReturnTasks) {
      setQuickReturnSessionContext(null);
    }
  }, [tasks]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks]
  );
  const userCanOperate = canOperate(profile?.role);

  const state = useMemo<FieldWorkflowState | null>(() => {
    if (!selectedTask) return null;
    return {
      workflow: selectedTask.workflow,
      assetStatus: selectedTask.assetStatus,
      contractStatus: selectedTask.contractStatus,
      downtimeMinutes: selectedTask.downtimeMinutes,
      inspectionType,
      inspectionOutcome,
    };
  }, [selectedTask, inspectionType, inspectionOutcome]);

  const evaluation = useMemo(
    () =>
      state
        ? evaluateFieldWorkflow(state)
        : {
            blockedReasons: [],
            finalAssetStatus: 'available' as AssetStatus,
          },
    [state]
  );
  const hasBlockingReasons = evaluation.blockedReasons.length > 0;

  const refreshTasks = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const loadedTasks = await loadFieldTasks(profile?.id ?? null);
      setTasks(loadedTasks);
      if (loadedTasks.length === 0) {
        setSelectedTaskId(null);
      } else {
        setSelectedTaskId((current) =>
          current && loadedTasks.some((task) => task.id === current) ? current : loadedTasks[0].id
        );
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load field tasks.');
    } finally {
      setIsLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const refreshInventory = useCallback(async () => {
    setInventoryLoadError(null);
    try {
      const summary = await loadInventorySummary();
      setInventorySummary(summary);
    } catch (error) {
      setInventoryLoadError(error instanceof Error ? error.message : 'Failed to load inventory.');
    }
  }, []);

  useEffect(() => {
    void refreshInventory();
  }, [refreshInventory]);

  const resetQuickCheckoutResolution = useCallback(() => {
    setQuickScanStatus(null);
    setQuickSubmissionSummary(null);
    setQuickTask(null);
  }, []);

  const handleQuickScan = useCallback(async () => {
    const trimmedScan = quickScan.trim();
    if (!trimmedScan) {
      setQuickScanStatus('Scan or enter an asset identifier to start quick checkout.');
      setQuickTask(null);
      return;
    }

    setIsQuickResolving(true);
    resetQuickCheckoutResolution();

    try {
      const matchedTask = await resolveQuickOrderTask(trimmedScan, tasks);
      if (matchedTask === 'ambiguous') {
        setQuickScanStatus('Multiple checkout tasks match this input. Enter a more specific value to identify the asset.');
        return;
      }
      if (!matchedTask) {
        setQuickScanStatus('No pending checkout task found for this asset. Check the task queue below.');
        return;
      }
      setQuickTask(matchedTask);
    } catch (error) {
      setQuickScanStatus(error instanceof Error ? error.message : 'Scan resolution failed.');
    } finally {
      setIsQuickResolving(false);
    }
  }, [quickScan, tasks]);

  const handleQuickCheckout = useCallback(async () => {
    if (!quickTask) {
      return;
    }
    if (!userCanOperate) {
      setQuickSubmissionSummary('Your role does not have permission to approve field workflow events.');
      return;
    }
    if (!quickSignature.trim()) {
      setQuickSubmissionSummary('Signature is required to complete checkout.');
      return;
    }
    if (!quickDriver.trim() || !quickTruck.trim() || !quickDeparture || !quickDriverSignature.trim()) {
      setQuickSubmissionSummary('Confirm load requires assigned driver, truck, departure timestamp, and driver signature.');
      return;
    }

    const departureAtIso = toIsoFromDateTimeLocal(quickDeparture);
    if (!departureAtIso) {
      setQuickSubmissionSummary('Departure timestamp must be a valid local date and time.');
      return;
    }

    const evaluation = evaluateFieldWorkflow({
      workflow: 'checkout',
      assetStatus: quickTask.assetStatus,
      contractStatus: quickTask.contractStatus,
      downtimeMinutes: quickTask.downtimeMinutes,
      inspectionType: 'checkout',
      inspectionOutcome: 'pass',
    });
    if (evaluation.blockedReasons.length > 0) {
      setQuickSubmissionSummary(evaluation.blockedReasons[0]);
      return;
    }

    setIsQuickSubmitting(true);
    setQuickSubmissionSummary(null);

    try {
      const timestamp = new Date().toISOString();
      const resultingAssetStatus = toDbAssetStatus(evaluation.finalAssetStatus);
      const confirmLoadPayload = {
        assigned_driver: quickDriver.trim(),
        assigned_truck: quickTruck.trim(),
        departure_at: departureAtIso,
        driver_signature: quickDriverSignature.trim(),
      };
      const evidencePayload = {
        checklist_items: null,
        signature: quickSignature.trim(),
        signature_confirmed: true,
        approval_event_type: 'delivery' as ApprovalEventType,
        approval_status: 'approved',
        approver_id: profile?.id ?? null,
        approved_at: timestamp,
        notes: null,
        meter_reading: null,
        meter_unit: DEFAULT_METER_UNIT,
        fuel_level_pct: null,
        location: 'Not captured',
        photo_paths: [],
        confirm_load: confirmLoadPayload,
        checklist: null,
      };

      const { error: contractLineError } = await supabase.rpc('rental_upsert_entity_current_state', {
        p_entity_type: 'rental_contract_line',
        p_entity_id: quickTask.contractLineId,
        p_data: {
          ...quickTask.lineData,
          ...quickTask.assignmentData,
          status: 'checked_out',
          contract_id: quickTask.contractId,
          asset_id: quickTask.assetId,
          condition_outcome: 'pass',
          resulting_asset_status: resultingAssetStatus,
          asset_name_snapshot: quickTask.assetName,
          field_evidence: evidencePayload,
          project_context_id: quickTask.projectContextId || null,
          cost_code: quickTask.costCode || null,
          confirm_load: confirmLoadPayload,
          actual_start: timestamp,
        },
      });
      if (contractLineError) {
        throw new Error(contractLineError.message);
      }

      const { error: assetError } = await supabase.rpc('rental_upsert_entity_current_state', {
        p_entity_type: 'asset',
        p_entity_id: quickTask.assetId,
        p_data: {
          ...quickTask.assetState,
          status: resultingAssetStatus,
          last_field_workflow: 'checkout',
          updated_at: timestamp,
        },
      });
      if (assetError) {
        throw new Error(assetError.message);
      }

      setQuickSubmissionSummary(`Quick checkout completed for ${quickTask.assetName}.`);
      setQuickTask(null);
      setQuickScan('');
      setQuickDriver('');
      setQuickTruck('');
      setQuickDeparture('');
      setQuickDriverSignature('');
      setQuickSignature('');
      await refreshTasks();
      await refreshInventory();
    } catch (error) {
      setQuickSubmissionSummary(error instanceof Error ? error.message : 'Quick checkout failed.');
    } finally {
      setIsQuickSubmitting(false);
    }
  }, [
    profile?.id,
    quickDeparture,
    quickDriver,
    quickDriverSignature,
    quickSignature,
    quickTask,
    quickTruck,
    refreshInventory,
    refreshTasks,
    resetQuickCheckoutResolution,
    userCanOperate,
  ]);

  useEffect(() => {
    if (!selectedTask) {
      return;
    }
    setInspectionType(selectedTask.inspectionType);
    setInspectionOutcome('pass');
    setSignature('');
    setCaptureSignatureConsent(false);
    setAssignedDriver('');
    setAssignedTruck('');
    setDepartureTimestamp('');
    setDriverSignature('');
    setApprovalEventType(toApprovalEventType(selectedTask.workflow));
    setProjectContextId(selectedTask.projectContextId);
    setCostCode(selectedTask.costCode);
    setNotes('');
    setMeterReading('');
    setFuelLevel('');
    setPhotoFiles([]);
    setLocation('Not captured');
    setLocationStatus('Location capture optional');
    setSubmissionSummary(null);
    setChecklistItems([]);
  }, [selectedTaskId, selectedTask]);

  useEffect(() => {
    if (!selectedTask) {
      setChecklistItems([]);
      return;
    }
    const checklistIntent = inspectionType === 'checkout' ? 'pickup' : 'return';
    let isCancelled = false;

    const loadChecklist = async () => {
      try {
        const tenantItems = await loadChecklistTemplateItems(selectedTask.assetCategoryName, checklistIntent);
        if (isCancelled) {
          return;
        }
        setChecklistItems(
          restoreChecklistTemplate(selectedTask.id, selectedTask.assetCategoryName, checklistIntent, tenantItems)
        );
      } catch (error) {
        console.error('Failed to load inspection checklist template items.', error);
        if (isCancelled) {
          return;
        }
        setChecklistItems(restoreChecklistTemplate(selectedTask.id, selectedTask.assetCategoryName, checklistIntent));
      }
    };

    void loadChecklist();

    return () => {
      isCancelled = true;
    };
  }, [inspectionType, selectedTask]);

  const updateChecklistItem = (key: string, status: ChecklistItemStatus, note?: string) => {
    setChecklistItems((prev) => {
      const updatedItems = prev.map((item) =>
        item.key === key
          ? { ...item, status, note: note !== undefined ? note : item.note }
          : item
      );

      if (selectedTask) {
        writeChecklistDraftSnapshot(selectedTask.id, {
          categoryName: selectedTask.assetCategoryName,
          intent: inspectionType === 'checkout' ? 'pickup' : 'return',
          items: updatedItems.map((item) => ({ key: item.key, status: item.status, note: item.note })),
        });
      }

      return updatedItems;
    });
  };

  const captureLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus('Geolocation is unavailable in this browser.');
      return;
    }

    setLocationStatus('Capturing current device location...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latitude = position.coords.latitude.toFixed(LOCATION_DECIMAL_PLACES);
        const longitude = position.coords.longitude.toFixed(LOCATION_DECIMAL_PLACES);
        setLocation(`${latitude}, ${longitude}`);
        setLocationStatus('Location captured from browser permissions.');
      },
      (error) => {
        if (error.code === GEOLOCATION_PERMISSION_DENIED) {
          setLocationStatus('Location permission denied. Continue without location metadata.');
          return;
        }
        setLocationStatus('Location capture failed. Continue without location metadata.');
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: LOCATION_TIMEOUT_MS }
    );
  };

  const handleQuickReturnScan = useCallback(async () => {
    const trimmedScan = quickReturnScan.trim();
    if (!trimmedScan) {
      setQuickReturnError('Enter a scan value or serial number to start a quick return.');
      return;
    }

    setQuickReturnIsResolving(true);
    setQuickReturnError(null);
    setQuickReturnCandidates([]);
    setQuickReturnSelectedCandidateId(null);
    setQuickReturnContextConflict(null);

    try {
      const returnTasks = tasks.filter((t) => t.workflow === 'return');
      const { candidates, resolvedAssetId } = await resolveReturnScanCandidates(trimmedScan, returnTasks);

      if (!resolvedAssetId || candidates.length === 0) {
        setQuickReturnError('No return task found for this scan. Verify the asset is assigned to you and is checked out.');
        return;
      }

      const { task, isContextMatch, requiresDisambiguation } = selectReturnCandidateWithContext(
        candidates,
        quickReturnSessionContext
      );

      if (requiresDisambiguation) {
        setQuickReturnCandidates(candidates);
        return;
      }

      if (task && !isContextMatch && quickReturnSessionContext) {
        setQuickReturnContextConflict(task);
        return;
      }

      if (task) {
        setSelectedTaskId(task.id);
        setQuickReturnScan('');
      }
    } catch (error) {
      setQuickReturnError(error instanceof Error ? error.message : 'Scan resolution failed.');
    } finally {
      setQuickReturnIsResolving(false);
    }
  }, [quickReturnScan, tasks, quickReturnSessionContext]);

  const handleQuickReturnStartTask = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      setQuickReturnScan('');
      setQuickReturnCandidates([]);
      setQuickReturnSelectedCandidateId(null);
      setQuickReturnContextConflict(null);
    },
    []
  );

  const handleQuickReturnSwitchContext = useCallback(() => {
    if (quickReturnContextConflict) {
      setSelectedTaskId(quickReturnContextConflict.id);
      setQuickReturnScan('');
      setQuickReturnContextConflict(null);
      setQuickReturnCandidates([]);
    }
  }, [quickReturnContextConflict]);

  const handleInventoryAdjust = async () => {
    if (!userCanOperate) {
      setAdjustSummary('Your role does not have permission to adjust inventory.');
      return;
    }
    const trimmedScanValue = adjustScanValue.trim();
    if (!adjustAssetId.trim() && !trimmedScanValue) {
      setAdjustSummary('Enter an asset ID or scan a QR/barcode.');
      return;
    }
    if (!adjustReason.trim()) {
      setAdjustSummary('Enter a reason for the status adjustment.');
      return;
    }

    setIsAdjusting(true);
    setAdjustSummary(null);

    try {
      const trimmedId = await resolveInventoryAdjustmentAssetId(adjustAssetId, trimmedScanValue);
      if (!trimmedId) {
        setAdjustSummary('Enter an asset ID or scan a QR/barcode.');
        return;
      }

      const uploadedPhotoPaths: string[] = [];
      const uploadAssetKey = sanitizeStoragePathSegment(trimmedId);
      for (const file of adjustPhotoFiles) {
        const uploadPath = `inventory-adjust/${uploadAssetKey}/${createUploadKeyPrefix()}-${sanitizeUploadFilename(file.name)}`;
        const { error } = await supabase.storage.from('field-evidence').upload(uploadPath, file);
        if (error) {
          throw new Error(`Photo upload failed: ${error.message}`);
        }
        uploadedPhotoPaths.push(uploadPath);
      }

      const { error } = await supabase.rpc('rental_upsert_entity_current_state', {
        p_entity_type: 'asset',
        p_entity_id: trimmedId,
        p_data: {
          status: toDbAssetStatus(adjustStatus),
          inventory_adjustment_reason: adjustReason.trim(),
          ...(trimmedScanValue ? { inventory_adjustment_scan_value: trimmedScanValue } : {}),
          ...(uploadedPhotoPaths.length ? { inventory_adjustment_photo_paths: uploadedPhotoPaths } : {}),
          ...(trimmedScanValue || uploadedPhotoPaths.length
            ? { inventory_adjustment_captured_at: new Date().toISOString() }
            : {}),
        },
      });

      if (error) {
        throw new Error(error.message);
      }

      const evidenceSummary =
        trimmedScanValue || uploadedPhotoPaths.length
          ? ` (${[
              trimmedScanValue ? 'scan captured' : null,
              uploadedPhotoPaths.length
                ? `${uploadedPhotoPaths.length} photo${uploadedPhotoPaths.length === 1 ? '' : 's'} attached`
                : null,
            ]
              .filter(Boolean)
              .join(', ')})`
          : '';
      setAdjustSummary(`Asset status updated to ${ASSET_STATUS_LABELS[adjustStatus]}.${evidenceSummary}`);
      setAdjustAssetId('');
      setAdjustScanValue('');
      setAdjustReason('');
      setAdjustPhotoFiles([]);
      await refreshInventory();
    } catch (error) {
      setAdjustSummary(error instanceof Error ? error.message : 'Adjustment failed.');
    } finally {
      setIsAdjusting(false);
    }
  };

  const handleSubmit = async () => {
    if (!selectedTask || !state) {
      setSubmissionSummary('Select a task from the queue before submitting.');
      return;
    }
    if (!userCanOperate) {
      setSubmissionSummary('Your role does not have permission to approve field workflow events.');
      return;
    }
    if (!signature.trim()) {
      setSubmissionSummary('Field execution requires signature capture and operator confirmation.');
      return;
    }
    const requiresConfirmLoad = selectedTask.workflow === 'checkout';
    const missingConfirmLoadFields = !assignedDriver.trim() || !assignedTruck.trim() || !departureTimestamp || !driverSignature.trim();
    if (requiresConfirmLoad && missingConfirmLoadFields) {
      setSubmissionSummary('Confirm load requires assigned driver, truck, departure timestamp, and driver signature.');
      return;
    }
    let departureAtIso: string | null = null;
    if (requiresConfirmLoad) {
      departureAtIso = toIsoFromDateTimeLocal(departureTimestamp);
    }
    if (requiresConfirmLoad && departureAtIso === null) {
      setSubmissionSummary('Confirm load departure timestamp must be a valid local date and time.');
      return;
    }
    if (hasBlockingReasons) {
      setSubmissionSummary('Workflow remains blocked. Resolve all blocking reasons before submitting.');
      return;
    }

    setIsSubmitting(true);
    setSubmissionSummary(null);

    try {
      const uploadedPhotoPaths: string[] = [];
      const timestamp = new Date().toISOString();
      const resultingAssetStatus = toDbAssetStatus(evaluation.finalAssetStatus);
      const confirmLoadPayload = requiresConfirmLoad
        ? {
            assigned_driver: assignedDriver.trim(),
            assigned_truck: assignedTruck.trim(),
            departure_at: departureAtIso,
            driver_signature: driverSignature.trim(),
          }
        : null;

      for (const file of photoFiles) {
        const uploadPath = `${selectedTask.contractLineId}/${createUploadKeyPrefix()}-${sanitizeUploadFilename(file.name)}`;
        const { error } = await supabase.storage.from('field-evidence').upload(uploadPath, file);
        if (error) {
          throw new Error(`Photo upload failed: ${error.message}`);
        }
        uploadedPhotoPaths.push(uploadPath);
      }

      const evidencePayload = {
        checklist_items: checklistItems.length
          ? checklistItems
              .filter((item) => item.status !== 'pending' || !!item.note)
              .map((item) => ({
                key: item.key,
                label: item.label,
                section: item.section,
                required: item.required,
                status: item.status,
                note: item.note || null,
              }))
          : null,
        signature,
        signature_confirmed: true,
        approval_event_type: approvalEventType,
        approval_status: 'approved',
        approver_id: profile?.id ?? null,
        approved_at: timestamp,
        notes,
        meter_reading: meterReading ? Number(meterReading) : null,
        meter_unit: DEFAULT_METER_UNIT,
        fuel_level_pct: fuelLevel ? Number(fuelLevel) : null,
        location,
        photo_paths: uploadedPhotoPaths,
        confirm_load: confirmLoadPayload,
        checklist:
          checklistItems.length
            ? checklistItems
                .filter((item) => item.status !== 'pending' || !!item.note)
                .map((item) => ({
                  key: item.key,
                  label: item.label,
                  section: item.section,
                  required: item.required,
                  status: item.status,
                  note: item.note || null,
                }))
            : null,
      };

      if (WORKFLOWS_WITH_LINE_STATE.includes(selectedTask.workflow)) {
        const lineStatus = selectedTask.workflow === 'checkout' ? 'checked_out' : 'returned';
        const { error } = await supabase.rpc('rental_upsert_entity_current_state', {
          p_entity_type: 'rental_contract_line',
          p_entity_id: selectedTask.contractLineId,
          p_data: {
            ...selectedTask.lineData,
            ...selectedTask.assignmentData,
            status: lineStatus,
            contract_id: selectedTask.contractId,
            asset_id: selectedTask.assetId,
            condition_outcome: inspectionOutcome,
            resulting_asset_status: resultingAssetStatus,
            asset_name_snapshot: selectedTask.assetName,
            field_evidence: evidencePayload,
            project_context_id: projectContextId || selectedTask.projectContextId || null,
            cost_code: costCode || selectedTask.costCode || null,
            ...(requiresConfirmLoad ? { confirm_load: confirmLoadPayload } : {}),
            ...(selectedTask.workflow === 'checkout' ? { actual_start: timestamp } : {}),
            ...(selectedTask.workflow === 'return' ? { actual_end: timestamp } : {}),
          },
        });

        if (error) {
          throw new Error(error.message);
        }
      }

      if (selectedTask.workflow === 'return' || selectedTask.workflow === 'inspection') {
        const { error } = await supabase.rpc('create_entity_with_version', {
          p_entity_type: 'inspection',
          p_data: {
            asset_id: selectedTask.assetId,
            contract_line_id: selectedTask.contractLineId,
            inspection_type: inspectionType,
            outcome: inspectionOutcome,
            resulting_asset_status: resultingAssetStatus,
            inspected_at: timestamp,
            notes,
            evidence: evidencePayload,
          },
        });

        if (error) {
          throw new Error(error.message);
        }
      }

      const { error: assetStateError } = await supabase.rpc('rental_upsert_entity_current_state', {
        p_entity_type: 'asset',
        p_entity_id: selectedTask.assetId,
        p_data: {
          ...selectedTask.assetState,
          status: resultingAssetStatus,
          last_field_workflow: selectedTask.workflow,
          updated_at: timestamp,
        },
      });

      if (assetStateError) {
        throw new Error(assetStateError.message);
      }

      clearChecklistDraftSnapshot(selectedTask.id);
      if (selectedTask.workflow === 'return') {
        setQuickReturnSessionContext({
          contractId: selectedTask.contractId,
          customerName: selectedTask.customerName,
          jobSiteName: selectedTask.jobSiteName,
        });
      }
      setSubmissionSummary(
        `${selectedTask.workflow} completed for ${selectedTask.assetName}. Final asset status: ${evaluation.finalAssetStatus}.`
      );
      await refreshTasks();
      await refreshInventory();
    } catch (error) {
      setSubmissionSummary(error instanceof Error ? error.message : 'Submission failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-8 sm:space-y-6 sm:p-6">
      <Card>
        <CardHeader className="space-y-2 p-4 sm:p-6">
          <CardTitle className="text-xl sm:text-2xl">Field Task Queue</CardTitle>
          <CardDescription>
            Complete today&apos;s checkout, pickup/check-in, and inspection tasks with live rental context.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-base">Quick checkout</CardTitle>
          <CardDescription>Scan an asset tag or enter a barcode, serial number, or task text to start a fast checkout.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
          <div className="flex gap-2">
            <Input
              id="quick-scan"
              aria-label="Scan or enter asset identifier"
              placeholder="Scan barcode, QR code, serial, asset name, or contract"
              value={quickScan}
              onChange={(e) => {
                setQuickScan(e.target.value);
                resetQuickCheckoutResolution();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleQuickScan();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => { void handleQuickScan(); }}
              disabled={isQuickResolving || !userCanOperate}
            >
              {isQuickResolving ? 'Resolving…' : 'Find task'}
            </Button>
          </div>
          {quickScanStatus && <p className="text-sm text-muted-foreground">{quickScanStatus}</p>}
          {quickTask && (
            <div data-testid="quick-order-panel" className="space-y-3">
              <div className="rounded-md border bg-accent/20 p-3">
                <p className="text-sm font-medium">{quickTask.assetName}</p>
                <p className="text-sm text-muted-foreground">{quickTask.customerName} — {quickTask.jobSiteName}</p>
                <p className="text-xs text-muted-foreground">Contract: {quickTask.contractLabel} · {quickTask.timeLabel}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant="secondary">Asset: {ASSET_STATUS_LABELS[quickTask.assetStatus]}</Badge>
                  <Badge variant="outline">Contract: {quickTask.contractStatus}</Badge>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="quick-driver">Assigned driver</Label>
                  <Input id="quick-driver" value={quickDriver} onChange={(e) => setQuickDriver(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="quick-truck">Assigned truck</Label>
                  <Input id="quick-truck" value={quickTruck} onChange={(e) => setQuickTruck(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="quick-departure">Departure timestamp</Label>
                  <Input
                    id="quick-departure"
                    type="datetime-local"
                    value={quickDeparture}
                    onChange={(e) => setQuickDeparture(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="quick-driver-signature">Driver signature</Label>
                  <Input
                    id="quick-driver-signature"
                    placeholder="Type driver name as signature"
                    value={quickDriverSignature}
                    onChange={(e) => setQuickDriverSignature(e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="quick-signature">Customer/operator signature</Label>
                  <Input
                    id="quick-signature"
                    placeholder="Type signer name as signature"
                    value={quickSignature}
                    onChange={(e) => setQuickSignature(e.target.value)}
                  />
                </div>
              </div>
              <Button
                type="button"
                className="w-full"
                onClick={() => { void handleQuickCheckout(); }}
                disabled={isQuickSubmitting || !userCanOperate}
              >
                {isQuickSubmitting ? 'Submitting…' : 'Quick checkout'}
              </Button>
            </div>
          )}
          {quickSubmissionSummary && (
            <p data-testid="quick-checkout-status" className="text-sm text-muted-foreground">{quickSubmissionSummary}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-base">Inventory status</CardTitle>
          <CardDescription>Real-time asset counts across all statuses.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
          {inventoryLoadError ? (
            <Alert variant="destructive">
              <AlertTitle>Inventory unavailable</AlertTitle>
              <AlertDescription>{inventoryLoadError}</AlertDescription>
            </Alert>
          ) : inventorySummary ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{inventorySummary.total}</p>
                <p className="text-xs text-muted-foreground">Total</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold text-green-600">{inventorySummary.available}</p>
                <p className="text-xs text-muted-foreground">Available</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{inventorySummary.on_rent}</p>
                <p className="text-xs text-muted-foreground">On rent</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{inventorySummary.returned}</p>
                <p className="text-xs text-muted-foreground">Returned</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold text-amber-600">{inventorySummary.inspection_hold}</p>
                <p className="text-xs text-muted-foreground">Inspection hold</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{inventorySummary.maintenance}</p>
                <p className="text-xs text-muted-foreground">Maintenance</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{inventorySummary.in_transit}</p>
                <p className="text-xs text-muted-foreground">In transit</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading inventory…</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-base">Inventory adjust</CardTitle>
          <CardDescription>Correct an asset&apos;s status directly, with optional photo and QR/barcode evidence.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
          <div className="space-y-1">
            <Label htmlFor="adjust-asset-id">Asset ID</Label>
            <Input
              id="adjust-asset-id"
              placeholder="Paste or scan asset UUID"
              value={adjustAssetId}
              onChange={(e) => setAdjustAssetId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjust-scan-value">QR / barcode scan</Label>
            <Input
              id="adjust-scan-value"
              placeholder="Scan asset tag or paste barcode value"
              value={adjustScanValue}
              onChange={(e) => setAdjustScanValue(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              If the scan includes a UUID or known serial number, we&apos;ll match it to the asset automatically.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjust-status">New status</Label>
            <Select value={adjustStatus} onValueChange={(v) => setAdjustStatus(v as AssetStatus)}>
              <SelectTrigger id="adjust-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(ASSET_STATUS_LABELS) as [AssetStatus, string][]).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjust-reason">Reason for adjustment</Label>
            <Textarea
              id="adjust-reason"
              rows={2}
              placeholder="e.g. Spot-count correction, found on yard"
              value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjust-photo-evidence">Asset image</Label>
            <Input
              id="adjust-photo-evidence"
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => setAdjustPhotoFiles(Array.from(e.target.files ?? []))}
            />
            <p className="text-xs text-muted-foreground">{adjustPhotoFiles.length} photo(s) selected for inventory evidence</p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={handleInventoryAdjust}
            disabled={isAdjusting || !userCanOperate}
          >
            {isAdjusting ? 'Applying…' : 'Apply adjustment'}
          </Button>
          {adjustSummary && <p className="text-sm text-muted-foreground">{adjustSummary}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-base">Quick Return — Serialized scan</CardTitle>
          <CardDescription>Scan an asset barcode or serial number to start a return. Repeated scans in a multi-unit unload stay attached to the current session context.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
          {quickReturnSessionContext && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              <span className="font-medium">Session context:</span> {quickReturnSessionContext.customerName} — {quickReturnSessionContext.jobSiteName}
              <button
                type="button"
                className="ml-2 text-xs text-blue-600 underline"
                onClick={() => setQuickReturnSessionContext(null)}
              >
                Clear
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              id="quick-return-scan"
              placeholder="Scan barcode or enter serial number"
              value={quickReturnScan}
              onChange={(e) => {
                setQuickReturnScan(e.target.value);
                setQuickReturnError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleQuickReturnScan();
                }
              }}
              aria-label="Quick return scan"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => { void handleQuickReturnScan(); }}
              disabled={quickReturnIsResolving || !userCanOperate}
            >
              {quickReturnIsResolving ? 'Scanning…' : 'Scan'}
            </Button>
          </div>
          {quickReturnContextConflict && (
            <Alert>
              <AlertTitle>Different customer context</AlertTitle>
              <AlertDescription>
                This asset belongs to <span className="font-medium">{quickReturnContextConflict.customerName}</span> ({quickReturnContextConflict.jobSiteName}), which differs from the current session context. Switch context and continue?
                <div className="mt-2 flex gap-2">
                  <Button type="button" size="sm" onClick={handleQuickReturnSwitchContext}>
                    Switch context
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setQuickReturnContextConflict(null)}>
                    Cancel
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {quickReturnCandidates.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Multiple return tasks found — select the correct contract line:</p>
              {quickReturnCandidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => setQuickReturnSelectedCandidateId(candidate.id)}
                  className={`w-full rounded-lg border p-3 text-left text-sm transition ${
                    quickReturnSelectedCandidateId === candidate.id
                      ? 'border-primary bg-accent/40'
                      : 'hover:bg-accent/20'
                  }`}
                >
                  <span className="font-medium">{candidate.assetName}</span> — {candidate.contractLabel}
                  <br />
                  <span className="text-muted-foreground">{candidate.customerName} · {candidate.jobSiteName}</span>
                </button>
              ))}
              <Button
                type="button"
                disabled={!quickReturnSelectedCandidateId}
                onClick={() => {
                  if (quickReturnSelectedCandidateId) {
                    handleQuickReturnStartTask(quickReturnSelectedCandidateId);
                  }
                }}
              >
                Start return
              </Button>
            </div>
          )}
          {quickReturnError && <p className="text-sm text-destructive">{quickReturnError}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-base">Today&apos;s assigned tasks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading field tasks…</p>
          ) : loadError ? (
            <Alert variant="destructive">
              <AlertTitle>Unable to load field tasks</AlertTitle>
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No field tasks assigned.</p>
          ) : (
            tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => setSelectedTaskId(task.id)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  selectedTaskId === task.id ? 'border-primary bg-accent/40' : 'hover:bg-accent/20'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{task.workflow === 'checkout' ? 'Delivery / Checkout' : task.workflow === 'return' ? 'Pickup / Return' : 'Inspection'}</Badge>
                  <span className="text-sm font-medium">{task.assetName}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{task.customerName} - {task.jobSiteName}</p>
                <p className="mt-1 text-xs text-muted-foreground">{task.timeLabel}</p>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      {selectedTask && (
        <>
          <Card>
            <CardHeader className="p-4 sm:p-6">
              <CardTitle className="text-base">Task context</CardTitle>
              <CardDescription>Live asset and contract state pulled from the system of record.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <p className="text-sm"><span className="font-medium">Asset:</span> {selectedTask.assetName}</p>
                <p className="text-sm"><span className="font-medium">Contract:</span> {selectedTask.contractLabel}</p>
                <p className="text-sm"><span className="font-medium">Customer:</span> {selectedTask.customerName}</p>
                <p className="text-sm"><span className="font-medium">Job site:</span> {selectedTask.jobSiteName}</p>
                <p className="text-sm"><span className="font-medium">Project context:</span> {selectedTask.projectContextId || 'Not set'}</p>
                <p className="text-sm"><span className="font-medium">Cost code:</span> {selectedTask.costCode || 'Not set'}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">Asset: {ASSET_STATUS_LABELS[selectedTask.assetStatus]}</Badge>
                <Badge variant="outline">Contract: {selectedTask.contractStatus}</Badge>
                <Badge variant={selectedTask.downtimeMinutes > 0 ? 'destructive' : 'secondary'}>
                  {selectedTask.downtimeMinutes > 0 ? `Downtime ${selectedTask.downtimeMinutes}m` : 'No downtime'}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {(selectedTask.workflow === 'inspection' || selectedTask.workflow === 'return') && (
            <Card>
              <CardHeader className="p-4 sm:p-6">
                <CardTitle className="text-base">Inspection outcome</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-3 p-4 pt-0 sm:grid-cols-2 sm:p-6 sm:pt-0">
                <div className="space-y-1">
                  <Label htmlFor="inspection-type">Inspection type</Label>
                  <select
                    id="inspection-type"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={inspectionType}
                    onChange={(e) => setInspectionType(e.target.value as InspectionType)}
                  >
                    <option value="checkout">checkout</option>
                    <option value="return">return</option>
                    <option value="service">service</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="inspection-outcome">Inspection outcome</Label>
                  <select
                    id="inspection-outcome"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={inspectionOutcome}
                    onChange={(e) => setInspectionOutcome(e.target.value as InspectionOutcome)}
                  >
                    <option value="pass">pass</option>
                    <option value="fail">fail</option>
                  </select>
                </div>
              </CardContent>
            </Card>
          )}

          {checklistItems.length > 0 && (
            <Card>
              <CardHeader className="p-4 sm:p-6">
                <CardTitle className="text-base">Inspection checklist</CardTitle>
                <CardDescription>
                  {selectedTask.assetCategoryName
                    ? `${inspectionType === 'checkout' ? 'Pickup' : 'Return'} checklist — ${selectedTask.assetCategoryName}`
                    : `${inspectionType === 'checkout' ? 'Pickup' : 'Return'} inspection checklist`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4 pt-0 sm:p-6 sm:pt-0">
                {Array.from(new Set(checklistItems.map((i) => i.section))).map((section) => (
                  <div key={section} className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section}</p>
                    {checklistItems
                      .filter((item) => item.section === section)
                      .map((item) => (
                        <div key={item.key} className="rounded-md border p-3 space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex-1 text-sm">
                              {item.label}
                              {item.required && <span className="ml-1 text-destructive" aria-label="required">*</span>}
                            </span>
                            <div className="flex gap-1">
                              {(['pass', 'fail', 'na'] as ChecklistItemStatus[]).map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  aria-label={`${item.key} ${s}`}
                                  onClick={() => updateChecklistItem(item.key, s)}
                                  className={`rounded px-2 py-1 text-xs font-medium transition ${
                                    item.status === s
                                      ? s === 'pass'
                                        ? 'bg-green-600 text-white'
                                        : s === 'fail'
                                          ? 'bg-destructive text-destructive-foreground'
                                          : 'bg-secondary text-secondary-foreground'
                                      : 'border border-input bg-background hover:bg-accent/30'
                                  }`}
                                >
                                  {s === 'na' ? 'N/A' : s.charAt(0).toUpperCase() + s.slice(1)}
                                </button>
                              ))}
                            </div>
                          </div>
                          {item.status === 'fail' && (
                            <Textarea
                              rows={2}
                              aria-label={`Note for ${item.key}`}
                              placeholder="Describe the issue or damage"
                              value={item.note}
                              onChange={(e) => updateChecklistItem(item.key, item.status, e.target.value)}
                            />
                          )}
                        </div>
                      ))}
                  </div>
                ))}
                {checklistItems.some((i) => i.required && i.status === 'pending') && (
                  <p role="alert" className="text-xs text-amber-600">
                    Items marked with an asterisk (*) are required — mark each pass, fail, or N/A before submitting.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="p-4 sm:p-6">
              <CardTitle className="text-base">Execution evidence</CardTitle>
              <CardDescription>Capture signatures, photos, meter/fuel readings, and optional GPS.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="space-y-1">
                <Label htmlFor="signature">Customer/operator signature</Label>
                <Input
                  id="signature"
                  placeholder="Type signer name as captured signature"
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="signature-consent"
                  checked={captureSignatureConsent}
                  onCheckedChange={(checked) => setCaptureSignatureConsent(checked === true)}
                />
                <Label htmlFor="signature-consent">I confirm this signature was captured from the signer.</Label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="approval-event-type">Approval event type</Label>
                  <select
                    id="approval-event-type"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={approvalEventType}
                    onChange={(e) => setApprovalEventType(e.target.value as ApprovalEventType)}
                  >
                    <option value="requisition">requisition</option>
                    <option value="delivery">delivery</option>
                    <option value="off_rent">off_rent</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="project-context-id">Project context</Label>
                  <Input
                    id="project-context-id"
                    placeholder="Project ID, code, or job-site context"
                    value={projectContextId}
                    onChange={(e) => setProjectContextId(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cost-code">Cost code</Label>
                  <Input id="cost-code" placeholder="Cost code (optional)" value={costCode} onChange={(e) => setCostCode(e.target.value)} />
                </div>
                {selectedTask.workflow === 'checkout' && (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="assigned-driver">Assigned driver</Label>
                      <Input
                        id="assigned-driver"
                        value={assignedDriver}
                        onChange={(e) => setAssignedDriver(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="assigned-truck">Assigned truck</Label>
                      <Input
                        id="assigned-truck"
                        value={assignedTruck}
                        onChange={(e) => setAssignedTruck(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="departure-timestamp">Departure timestamp</Label>
                      <Input
                        id="departure-timestamp"
                        type="datetime-local"
                        aria-describedby="departure-timestamp-note"
                        value={departureTimestamp}
                        onChange={(e) => setDepartureTimestamp(e.target.value)}
                      />
                      <p id="departure-timestamp-note" className="text-xs text-muted-foreground">
                        Captured in your device&apos;s local time.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="driver-signature">Driver signature</Label>
                      <Input
                        id="driver-signature"
                        placeholder="Type driver name as captured signature"
                        value={driverSignature}
                        onChange={(e) => setDriverSignature(e.target.value)}
                      />
                    </div>
                  </>
                )}
                <div className="space-y-1">
                  <Label htmlFor="meter-reading">Meter ({DEFAULT_METER_UNIT})</Label>
                  <Input
                    id="meter-reading"
                    type="number"
                    min={0}
                    value={meterReading}
                    onChange={(e) => setMeterReading(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fuel-level">Fuel level (%)</Label>
                  <Input
                    id="fuel-level"
                    type="number"
                    min={0}
                    max={100}
                    value={fuelLevel}
                    onChange={(e) => setFuelLevel(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="photo-evidence">Photo evidence</Label>
                <Input
                  id="photo-evidence"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => setPhotoFiles(Array.from(e.target.files ?? []))}
                />
                <p className="text-xs text-muted-foreground">{photoFiles.length} photo(s) selected</p>
              </div>
              <div className="space-y-2">
                <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={captureLocation}>
                  Capture location metadata
                </Button>
                <p className="text-sm text-muted-foreground">{locationStatus}</p>
                <p className="text-sm">Current location: {location}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="workflow-notes">Condition / damage notes</Label>
                <Textarea
                  id="workflow-notes"
                  rows={3}
                  placeholder="Add condition notes, hold reason, or handoff details"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          {hasBlockingReasons ? (
            <Alert variant="destructive">
              <AlertTitle>Action required before completion</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {evaluation.blockedReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <AlertTitle>Task ready</AlertTitle>
              <AlertDescription>
                {`Completing this ${selectedTask.workflow} transitions the asset to ${evaluation.finalAssetStatus}.`}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            {!userCanOperate && (
              <Alert>
                <AlertTitle>Read-only role</AlertTitle>
                <AlertDescription>
                  Your account can view field context but cannot submit requisition, delivery, or off-rent approvals.
                </AlertDescription>
              </Alert>
            )}
            <Button type="button" className="w-full" onClick={handleSubmit} disabled={isSubmitting || !userCanOperate}>
              {isSubmitting ? 'Submitting…' : `Complete ${selectedTask.workflow}`}
            </Button>
            {submissionSummary && <p className="text-sm text-muted-foreground">{submissionSummary}</p>}
          </div>
        </>
      )}
    </div>
  );
}
