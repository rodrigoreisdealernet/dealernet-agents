/**
 * Inspection Comparison Route
 *
 * Side-by-side pickup/return comparison with condition delta and one-action
 * customer recap sharing from the inspection history.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ArrowLeftRight, Share2, CheckCircle2, XCircle, Minus, Copy, Camera, FileText } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/data/supabase';

export const Route = createFileRoute('/rental/inspection-comparison')({
  validateSearch: (search: Record<string, unknown>) => ({
    contract_line_id:
      typeof search.contract_line_id === 'string' && search.contract_line_id.trim() !== ''
        ? search.contract_line_id
        : undefined,
    asset_id:
      typeof search.asset_id === 'string' && search.asset_id.trim() !== ''
        ? search.asset_id
        : undefined,
    work_order_id:
      typeof search.work_order_id === 'string' && search.work_order_id.trim() !== ''
        ? search.work_order_id
        : undefined,
  }),
  component: InspectionComparisonPage,
});

export interface ChecklistItem {
  item: string;
  status: 'pass' | 'fail' | 'na';
  notes?: string;
}

interface PersistedChecklistItem {
  item?: string;
  key?: string;
  label?: string;
  status?: 'pass' | 'fail' | 'na' | 'pending';
  note?: string | null;
  notes?: string | null;
}

export interface InspectionEvidence {
  signature?: string | null;
  signature_confirmed?: boolean;
  approval_event_type?: string | null;
  approval_status?: string | null;
  approver_id?: string | null;
  approved_at?: string | null;
  notes?: string | null;
  meter_reading?: number | null;
  meter_unit?: string | null;
  fuel_level_pct?: number | null;
  location?: string | null;
  photo_paths?: string[];
  checklist_items?: ChecklistItem[];
  checklist?: PersistedChecklistItem[];
}

export interface InspectionData {
  asset_id?: string;
  contract_line_id?: string;
  inspection_type?: string;
  outcome?: string;
  resulting_asset_status?: string;
  inspected_at?: string;
  notes?: string | null;
  evidence?: InspectionEvidence | null;
}

export interface InspectionRecord {
  entityId: string;
  data: InspectionData;
  createdAt: string;
}

/** Sentinel value emitted by the mobile workflow for uncaptured GPS location. */
const LOCATION_NOT_CAPTURED = 'Not captured';

/** Fields included in a customer-safe recap (internal notes are excluded). */
export function buildCustomerRecap(inspection: InspectionRecord): {
  auditRef: string;
  inspectionType: string;
  outcome: string;
  resultingAssetStatus: string;
  inspectedAt: string;
  signatureCaptured: boolean;
  photoCount: number;
  meterReading: number | null;
  meterUnit: string | null;
  fuelLevelPct: number | null;
  location: string | null;
} {
  const d = inspection.data;
  const ev = d.evidence ?? {};
  return {
    auditRef: inspection.entityId,
    inspectionType: d.inspection_type ?? 'unknown',
    outcome: d.outcome ?? 'unknown',
    resultingAssetStatus: d.resulting_asset_status ?? 'unknown',
    inspectedAt: d.inspected_at ?? inspection.createdAt,
    signatureCaptured: !!(ev.signature_confirmed),
    photoCount: Array.isArray(ev.photo_paths) ? ev.photo_paths.length : 0,
    meterReading: typeof ev.meter_reading === 'number' ? ev.meter_reading : null,
    meterUnit: typeof ev.meter_unit === 'string' ? ev.meter_unit : null,
    fuelLevelPct: typeof ev.fuel_level_pct === 'number' ? ev.fuel_level_pct : null,
    location: typeof ev.location === 'string' && ev.location !== LOCATION_NOT_CAPTURED ? ev.location : null,
  };
}

export function buildCustomerRecapShareText(
  pickupInspection: InspectionRecord | null,
  returnInspection: InspectionRecord | null,
): string {
  const sections = [
    {
      title: 'Pickup / Checkout Inspection',
      recap: pickupInspection ? buildCustomerRecap(pickupInspection) : null,
    },
    {
      title: 'Return Inspection',
      recap: returnInspection ? buildCustomerRecap(returnInspection) : null,
    },
  ].filter((section) => section.recap);

  if (sections.length === 0) {
    return '';
  }

  const auditRefs = sections.map((section) => section.recap?.auditRef).filter(Boolean).join(', ');

  return [
    'Customer Inspection Recap',
    ...sections.flatMap(({ title, recap }) => {
      if (!recap) {
        return [];
      }

      const lines = [
        `Outcome: ${recap.outcome}`,
        `Asset status: ${recap.resultingAssetStatus}`,
        `Inspection type: ${recap.inspectionType}`,
        `Date / time: ${recap.inspectedAt}`,
        `Signature: ${recap.signatureCaptured ? 'Captured' : 'Not captured'}`,
        `Photos: ${recap.photoCount}`,
        `Audit ref: ${recap.auditRef}`,
      ];

      if (recap.meterReading != null) {
        lines.push(`Meter reading: ${recap.meterReading}${recap.meterUnit ? ` ${recap.meterUnit}` : ''}`);
      }
      if (recap.fuelLevelPct != null) {
        lines.push(`Fuel level: ${recap.fuelLevelPct}%`);
      }
      if (recap.location) {
        lines.push(`Location: ${recap.location}`);
      }

      return [title, ...lines, ''];
    }),
    `Audit references: ${auditRefs}`,
  ].join('\n');
}

/** Compare two inspections and return delta flags. */
export function buildConditionDelta(
  pickup: InspectionRecord | null,
  returnInsp: InspectionRecord | null,
): {
  outcomeChanged: boolean;
  meterChanged: boolean;
  fuelChanged: boolean;
  photoCountChanged: boolean;
  signatureChanged: boolean;
} {
  if (!pickup || !returnInsp) {
    return {
      outcomeChanged: false,
      meterChanged: false,
      fuelChanged: false,
      photoCountChanged: false,
      signatureChanged: false,
    };
  }
  const pEv = pickup.data.evidence ?? {};
  const rEv = returnInsp.data.evidence ?? {};
  const pPhotos = Array.isArray(pEv.photo_paths) ? pEv.photo_paths.length : 0;
  const rPhotos = Array.isArray(rEv.photo_paths) ? rEv.photo_paths.length : 0;
  return {
    outcomeChanged: pickup.data.outcome !== returnInsp.data.outcome,
    meterChanged: pEv.meter_reading !== rEv.meter_reading,
    fuelChanged: pEv.fuel_level_pct !== rEv.fuel_level_pct,
    photoCountChanged: pPhotos !== rPhotos,
    signatureChanged: !!(pEv.signature_confirmed) !== !!(rEv.signature_confirmed),
  };
}

function getChecklistItems(evidence: InspectionEvidence | null | undefined): ChecklistItem[] {
  const rawItems = Array.isArray(evidence?.checklist_items)
    ? evidence.checklist_items
    : Array.isArray(evidence?.checklist)
      ? evidence.checklist
      : [];

  return rawItems.flatMap((rawItem) => {
    const item = rawItem as ChecklistItem & PersistedChecklistItem;
    let label: string | null = null;
    if (typeof item.item === 'string' && item.item.trim() !== '') {
      label = item.item;
    } else if (typeof item.label === 'string' && item.label.trim() !== '') {
      label = item.label;
    } else if (typeof item.key === 'string' && item.key.trim() !== '') {
      label = item.key;
    }
    const status =
      item.status === 'pass' || item.status === 'fail' || item.status === 'na'
        ? item.status
        : null;

    if (!label || !status) {
      return [];
    }

    return [
      {
        item: label,
        status,
        notes:
          typeof item.notes === 'string'
            ? item.notes
            : typeof item.note === 'string'
              ? item.note
              : undefined,
      },
    ];
  });
}

export interface ChecklistItemVariance {
  item: string;
  pickupStatus: ChecklistItem['status'] | null;
  returnStatus: ChecklistItem['status'] | null;
  changed: boolean;
}

interface EvidenceBundleDeficiency {
  id: string;
  label: string;
  status: 'open' | 'resolved';
  resolvedAt: string | null;
  resolvedBy: string | null;
}

interface EvidenceBundleAuditEntry {
  id: string;
  event: string;
  detail: string;
  occurredAt: string;
  actor: string | null;
}

interface InspectionEvidenceBundle {
  scopeKey: string;
  assetId: string | null;
  contractLineId: string | null;
  workOrderId: string | null;
  pickupInspectionId: string | null;
  returnInspectionId: string | null;
  reviewerName: string;
  releaseNotes: string;
  requiredInspectionPassed: boolean;
  releaseStatus: 'blocked' | 'rent_ready';
  releaseReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deficiencies: EvidenceBundleDeficiency[];
  auditTrail: EvidenceBundleAuditEntry[];
}

const EVIDENCE_BUNDLE_STORAGE_PREFIX = 'inspection_evidence_bundle:';
/**
 * Keep the audit trail reviewable in-card while still retaining the most recent
 * evidence bundle actions across reloads. Older entries are dropped once this
 * cap is reached because the bundle is a lightweight browser-persisted artifact.
 */
const MAX_BUNDLE_AUDIT_ENTRIES = 20;

/** Compare checklist items across pickup and return inspections. */
export function buildChecklistVariance(
  pickup: InspectionRecord | null,
  returnInsp: InspectionRecord | null,
): ChecklistItemVariance[] {
  const pItems = getChecklistItems(pickup?.data.evidence);
  const rItems = getChecklistItems(returnInsp?.data.evidence);

  const allItemNames = new Set([...pItems.map((i) => i.item), ...rItems.map((i) => i.item)]);

  return Array.from(allItemNames).map((itemName) => {
    const pEntry = pItems.find((i) => i.item === itemName) ?? null;
    const rEntry = rItems.find((i) => i.item === itemName) ?? null;
    return {
      item: itemName,
      pickupStatus: pEntry ? pEntry.status : null,
      returnStatus: rEntry ? rEntry.status : null,
      changed: pEntry?.status !== rEntry?.status,
    };
  });
}

function buildChecklistStatusSummary(inspection: InspectionRecord | null): Record<ChecklistItem['status'], number> {
  return getChecklistItems(inspection?.data.evidence).reduce<Record<ChecklistItem['status'], number>>(
    (summary, item) => {
      summary[item.status] += 1;
      return summary;
    },
    { pass: 0, fail: 0, na: 0 },
  );
}

function buildDeficiencyId(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function createAuditEntry(event: string, detail: string, actor: string | null, occurredAt = new Date().toISOString()): EvidenceBundleAuditEntry {
  const uniqueSuffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return {
    id: `${occurredAt}:${uniqueSuffix}:${buildDeficiencyId(`${event}-${detail}`)}`,
    event,
    detail,
    occurredAt,
    actor,
  };
}

function buildScopeKey(
  assetId?: string | null,
  contractLineId?: string | null,
  pickupInspectionId?: string | null,
  returnInspectionId?: string | null,
  workOrderId?: string | null,
): string | null {
  const normalizedAssetId = assetId?.trim() || null;
  const normalizedContractLineId = contractLineId?.trim() || null;
  const normalizedPickupInspectionId = pickupInspectionId?.trim() || null;
  const normalizedReturnInspectionId = returnInspectionId?.trim() || null;
  const normalizedWorkOrderId = workOrderId?.trim() || null;

  if (!normalizedAssetId && !normalizedContractLineId && !normalizedPickupInspectionId && !normalizedReturnInspectionId && !normalizedWorkOrderId) {
    return null;
  }

  if (!normalizedAssetId && !normalizedContractLineId && !normalizedPickupInspectionId && !normalizedReturnInspectionId) {
    return [
      'no-asset',
      'no-line',
      'no-pickup-inspection',
      'no-return-inspection',
      normalizedWorkOrderId,
    ].join('::');
  }

  return [
    normalizedAssetId ?? 'no-asset',
    normalizedContractLineId ?? 'no-line',
    normalizedPickupInspectionId ?? 'no-pickup-inspection',
    normalizedReturnInspectionId ?? 'no-return-inspection',
  ].join('::');
}

function readStoredBundle(scopeKey: string | null): InspectionEvidenceBundle | null {
  if (!scopeKey || typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(`${EVIDENCE_BUNDLE_STORAGE_PREFIX}${scopeKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as InspectionEvidenceBundle;
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function persistBundle(bundle: InspectionEvidenceBundle | null): void {
  if (!bundle || typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      `${EVIDENCE_BUNDLE_STORAGE_PREFIX}${bundle.scopeKey}`,
      JSON.stringify(bundle),
    );
  } catch {
    // localStorage unavailable or quota exceeded — keep the in-memory bundle.
  }
}

function mergeBundle(
  scopeKey: string,
  pickupInspection: InspectionRecord | null,
  returnInspection: InspectionRecord | null,
  assetId: string | null,
  contractLineId: string | null,
  workOrderId: string | null,
): InspectionEvidenceBundle {
  const stored = readStoredBundle(scopeKey);
  const timestamp = new Date().toISOString();
  const derivedDeficiencies = getChecklistItems(returnInspection?.data.evidence)
    .filter((item) => item.status === 'fail')
    .map((item) => {
      const deficiencyId = buildDeficiencyId(item.item);
      const existing = stored?.deficiencies.find((entry) => entry.id === deficiencyId);
      return {
        id: deficiencyId,
        label: item.item,
        status: existing?.status ?? 'open',
        resolvedAt: existing?.resolvedAt ?? null,
        resolvedBy: existing?.resolvedBy ?? null,
      } satisfies EvidenceBundleDeficiency;
    });

  const auditTrail = stored?.auditTrail?.length
    ? stored.auditTrail
    : [
        createAuditEntry(
          'bundle_assembled',
          `Inspection bundle assembled for ${assetId ?? contractLineId ?? workOrderId ?? 'scoped review'}.`,
          null,
          timestamp,
        ),
      ];

  return {
    scopeKey,
    assetId,
    contractLineId,
    workOrderId: workOrderId ?? stored?.workOrderId ?? null,
    pickupInspectionId: pickupInspection?.entityId ?? stored?.pickupInspectionId ?? null,
    returnInspectionId: returnInspection?.entityId ?? stored?.returnInspectionId ?? null,
    reviewerName: stored?.reviewerName ?? '',
    releaseNotes: stored?.releaseNotes ?? '',
    requiredInspectionPassed: stored?.requiredInspectionPassed ?? false,
    releaseStatus: stored?.releaseStatus ?? 'blocked',
    releaseReviewedAt: stored?.releaseReviewedAt ?? null,
    createdAt: stored?.createdAt ?? timestamp,
    updatedAt: timestamp,
    deficiencies: derivedDeficiencies,
    auditTrail,
  };
}

function buildReleaseBlockingGaps(
  bundle: InspectionEvidenceBundle | null,
  pickupInspection: InspectionRecord | null,
  returnInspection: InspectionRecord | null,
): string[] {
  if (!bundle) return [];

  const gaps: string[] = [];
  if (!pickupInspection) {
    gaps.push('Outbound inspection context is missing.');
  }
  if (!returnInspection) {
    gaps.push('Return inspection evidence is missing.');
  }
  if (!bundle.requiredInspectionPassed) {
    gaps.push('Required inspection sign-off is still pending.');
  }
  if (bundle.deficiencies.some((deficiency) => deficiency.status === 'open')) {
    gaps.push('Open deficiencies remain unresolved.');
  }
  return gaps;
}

interface InspectionColumnProps {
  label: string;
  inspection: InspectionRecord | null;
  deltaFlags: ReturnType<typeof buildConditionDelta>;
  side: 'pickup' | 'return';
}

function OutcomeBadge({ outcome }: { outcome: string | undefined }) {
  if (outcome === 'pass') {
    return (
      <Badge variant="outline" className="gap-1 border-green-500 text-green-700">
        <CheckCircle2 className="h-3 w-3" />
        Pass
      </Badge>
    );
  }
  if (outcome === 'fail') {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" />
        Fail
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Minus className="h-3 w-3" />
      {outcome ?? 'No record'}
    </Badge>
  );
}

function DeltaBadge({ changed }: { changed: boolean }) {
  if (changed) {
    return <Badge variant="destructive" className="ml-1 text-xs">Changed</Badge>;
  }
  return <Badge variant="outline" className="ml-1 text-xs text-muted-foreground">Same</Badge>;
}

function ChecklistStatusBadge({ status }: { status: ChecklistItem['status'] | null }) {
  if (status === 'pass') {
    return (
      <Badge variant="outline" className="border-green-500 text-green-700 text-xs" aria-label="Status: Pass">Pass</Badge>
    );
  }
  if (status === 'fail') {
    return <Badge variant="destructive" className="text-xs" aria-label="Status: Fail">Fail</Badge>;
  }
  if (status === 'na') {
    return <Badge variant="secondary" className="text-xs" aria-label="Status: N/A">N/A</Badge>;
  }
  return <Badge variant="secondary" className="text-xs text-muted-foreground" aria-label="Status: Not recorded">—</Badge>;
}

function MediaGallery({ photoPaths }: { photoPaths: string[] }) {
  const photoUrls = useMemo(
    () =>
      photoPaths.map((path) => ({
        path,
        url: supabase.storage.from('field-evidence').getPublicUrl(path).data.publicUrl,
      })),
    [photoPaths],
  );

  if (photoUrls.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2 text-center">No photos recorded.</p>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-2">
      {photoUrls.map(({ path, url }) => (
        <img
          key={path}
          src={url}
          alt="Inspection evidence photo"
          aria-label={`Evidence photo: ${path}`}
          className="w-full rounded border object-cover aspect-square bg-muted"
        />
      ))}
    </div>
  );
}

function InspectionColumn({ label, inspection, deltaFlags, side }: InspectionColumnProps) {
  const d = inspection?.data;
  const ev = d?.evidence ?? {};
  const photoCount = Array.isArray(ev.photo_paths) ? ev.photo_paths.length : 0;
  const photoPaths = Array.isArray(ev.photo_paths) ? ev.photo_paths : [];
  const checklistItems = getChecklistItems(ev);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-base">{label}</h3>
        {inspection ? (
          <Badge variant="outline" className="text-xs font-mono">
            {inspection.entityId.slice(0, 8)}…
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">Not recorded</Badge>
        )}
      </div>

      {!inspection ? (
        <p className="text-sm text-muted-foreground py-4 text-center border rounded-lg">
          No {side === 'pickup' ? 'pickup / checkout' : 'return'} inspection found.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground w-28 shrink-0">Outcome</span>
            <OutcomeBadge outcome={d?.outcome} />
            <DeltaBadge changed={deltaFlags.outcomeChanged} />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground w-28 shrink-0">Asset status</span>
            <Badge variant="secondary">{d?.resulting_asset_status ?? '—'}</Badge>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground w-28 shrink-0">Inspected at</span>
            <span className="text-sm">{d?.inspected_at ? new Date(d.inspected_at).toLocaleString() : '—'}</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground w-28 shrink-0">Signature</span>
            {ev.signature_confirmed ? (
              <span className="text-sm text-green-700 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Captured
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">Not captured</span>
            )}
            <DeltaBadge changed={deltaFlags.signatureChanged} />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground w-28 shrink-0">Photos</span>
            <span className="text-sm flex items-center gap-1">
              <Camera className="h-3 w-3 text-muted-foreground" />
              {photoCount}
            </span>
            <DeltaBadge changed={deltaFlags.photoCountChanged} />
          </div>

          {ev.meter_reading != null && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-28 shrink-0">Meter</span>
              <span className="text-sm">
                {ev.meter_reading} {ev.meter_unit ?? ''}
              </span>
              <DeltaBadge changed={deltaFlags.meterChanged} />
            </div>
          )}

          {ev.fuel_level_pct != null && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-28 shrink-0">Fuel</span>
              <span className="text-sm">{ev.fuel_level_pct}%</span>
              <DeltaBadge changed={deltaFlags.fuelChanged} />
            </div>
          )}

          {ev.location && ev.location !== 'Not captured' && (
            <div className="flex items-start gap-2">
              <span className="text-sm text-muted-foreground w-28 shrink-0">Location</span>
              <span className="text-sm break-all">{ev.location}</span>
            </div>
          )}

          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <Camera className="h-3 w-3" /> Photo Evidence
            </p>
            <MediaGallery photoPaths={photoPaths} />
          </div>

          {checklistItems.length > 0 && (
            <div className="space-y-2 pt-2 border-t">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Checklist
              </p>
              {checklistItems.map((ci) => (
                <div key={ci.item} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 text-muted-foreground">{ci.item}</span>
                  <ChecklistStatusBadge status={ci.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RecapModalProps {
  pickupInspection: InspectionRecord | null;
  returnInspection: InspectionRecord | null;
  onClose: () => void;
}

function RecapModal({ pickupInspection, returnInspection, onClose }: RecapModalProps) {
  const [copied, setCopied] = useState(false);

  const pickupRecap = pickupInspection ? buildCustomerRecap(pickupInspection) : null;
  const returnRecap = returnInspection ? buildCustomerRecap(returnInspection) : null;

  const auditRefs = [pickupRecap?.auditRef, returnRecap?.auditRef].filter(Boolean).join(', ');

  const handleCopyRef = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(auditRefs);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [auditRefs]);

  function RecapSection({
    title,
    recap,
  }: {
    title: string;
    recap: ReturnType<typeof buildCustomerRecap> | null;
  }) {
    if (!recap) {
      return (
        <div>
          <h4 className="font-medium text-sm mb-1">{title}</h4>
          <p className="text-sm text-muted-foreground">No record available.</p>
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <h4 className="font-medium text-sm">{title}</h4>
        <div className="rounded-lg border p-3 text-sm space-y-1">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">Outcome</span>
            <OutcomeBadge outcome={recap.outcome} />
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">Asset status</span>
            <span>{recap.resultingAssetStatus}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">Date / time</span>
            <span>{new Date(recap.inspectedAt).toLocaleString()}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">Signature</span>
            <span>{recap.signatureCaptured ? 'Captured' : 'Not captured'}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">Photos</span>
            <span>{recap.photoCount}</span>
          </div>
          {recap.meterReading != null && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-36 shrink-0">Meter reading</span>
              <span>
                {recap.meterReading} {recap.meterUnit ?? ''}
              </span>
            </div>
          )}
          {recap.fuelLevelPct != null && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-36 shrink-0">Fuel level</span>
              <span>{recap.fuelLevelPct}%</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">Audit ref</span>
            <span className="font-mono text-xs">{recap.auditRef}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recap-modal-title"
    >
      <div className="bg-background rounded-lg shadow-lg w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="recap-modal-title" className="text-lg font-semibold">Customer Recap</h2>
              <p className="text-sm text-muted-foreground">
                Shared inspection summary — internal notes excluded. Use the audit references below
                to link this recap to the original inspection records.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close recap">
              ✕
            </Button>
          </div>

          <RecapSection title="Pickup / Checkout Inspection" recap={pickupRecap} />
          <RecapSection title="Return Inspection" recap={returnRecap} />

          <div className="border-t pt-4 space-y-2">
            <p className="text-xs text-muted-foreground">
              Audit references are stable identifiers tied to the original inspection records.
              Share these with the customer or attach to a dispute for traceable evidence.
            </p>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono bg-muted px-2 py-1 rounded flex-1 break-all">
                {auditRefs || '—'}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCopyRef}
                disabled={!auditRefs}
                aria-label="Copy audit references"
              >
                <Copy className="h-3 w-3 mr-1" />
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface InspectionComparisonScreenProps {
  initialContractLineId?: string;
  initialAssetId?: string;
  initialWorkOrderId?: string;
}

export function InspectionComparisonScreen({
  initialContractLineId,
  initialAssetId,
  initialWorkOrderId,
}: InspectionComparisonScreenProps = {}) {
  const [contractLineId, setContractLineId] = useState(initialContractLineId ?? '');
  const [assetId, setAssetId] = useState(initialAssetId ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickupInspection, setPickupInspection] = useState<InspectionRecord | null>(null);
  const [returnInspection, setReturnInspection] = useState<InspectionRecord | null>(null);
  const [showRecap, setShowRecap] = useState(false);
  const [recapCopied, setRecapCopied] = useState(false);
  const [recapCopyError, setRecapCopyError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [bundle, setBundle] = useState<InspectionEvidenceBundle | null>(null);
  const recapCopiedTimeoutRef = useRef<number | null>(null);

  const fetchInspections = useCallback(async (lineId: string, aId: string) => {
    if (!lineId.trim() && !aId.trim()) {
      setError('Enter a Contract Line ID or Asset ID to load inspections.');
      return;
    }
    setLoading(true);
    setError(null);
    setPickupInspection(null);
    setReturnInspection(null);
    setSearched(true);

    try {
      let query = supabase
        .from('entities')
        .select('id, created_at, entity_versions!inner(id, data, is_current, created_at)')
        .eq('entity_type', 'inspection')
        .eq('entity_versions.is_current', true)
        .order('created_at', { ascending: true });

      if (lineId.trim()) {
        // PostgREST supports JSONB path operators (data->>'key') as column names but the
        // Supabase JS client's TypeScript types do not model them; `as never` bypasses the
        // type-level column restriction while preserving the correct runtime behaviour.
        query = query.eq('entity_versions.data->>contract_line_id' as never, lineId.trim());
      } else if (aId.trim()) {
        query = query.eq('entity_versions.data->>asset_id' as never, aId.trim());
      }

      const { data, error: qErr } = await query;

      if (qErr) {
        throw new Error(qErr.message);
      }

      if (!data || data.length === 0) {
        setError('No inspections found for the provided identifier.');
        return;
      }

      type RawEntity = {
        id: string;
        created_at: string;
        entity_versions: Array<{ id: string; data: InspectionData; is_current: boolean; created_at: string }>;
      };

      const records: InspectionRecord[] = (data as RawEntity[]).map((entity) => {
        const version = Array.isArray(entity.entity_versions) ? entity.entity_versions[0] : null;
        return {
          entityId: entity.id,
          data: (version?.data ?? {}) as InspectionData,
          createdAt: entity.created_at,
        };
      });

      // Only apply contract-line grouping on the asset-ID search path when the
      // result set actually spans multiple rental cycles (i.e. multiple distinct
      // contract_line_id values). Contract-line-ID searches are already scoped to
      // a single line, so no grouping is needed. Asset-ID searches where all
      // records share one (or no) contract_line_id also fall through to the
      // original pairing logic below.
      const distinctLines = new Set(
        records.map((r) => r.data.contract_line_id).filter(Boolean),
      );
      const needsGrouping = !lineId.trim() && distinctLines.size > 1;

      let groupRecords = records;

      if (needsGrouping) {
        // Group by contract_line_id so that pickup and return always come from
        // the same rental event. Picking naively from the full asset result set
        // would pair inspections from different events.
        const groups = new Map<string, InspectionRecord[]>();
        for (const record of records) {
          const key = record.data.contract_line_id;
          if (!key) continue; // skip records that lack a contract_line_id
          const bucket = groups.get(key) ?? [];
          bucket.push(record);
          groups.set(key, bucket);
        }

        // Prefer the most recent group with a complete checkout+return pair.
        // Records arrive ordered by created_at ascending so the last qualifying
        // group is the most recently created one.
        let selectedGroup: InspectionRecord[] | null = null;
        for (const group of groups.values()) {
          const hasCheckout = group.some(
            (r) => r.data.inspection_type === 'checkout' || r.data.inspection_type === 'pickup',
          );
          const hasReturn = group.some((r) => r.data.inspection_type === 'return');
          if (hasCheckout && hasReturn) {
            selectedGroup = group;
          }
        }
        // No complete pair — fall back to the most recently created group.
        if (!selectedGroup) {
          const groupedRecords = Array.from(groups.values());
          selectedGroup = groupedRecords[groupedRecords.length - 1] ?? null;
        }
        groupRecords = selectedGroup ?? records;
      }

      const pickup = groupRecords.find(
        (r) => r.data.inspection_type === 'checkout' || r.data.inspection_type === 'pickup',
      ) ?? null;
      const ret = groupRecords.find((r) => r.data.inspection_type === 'return') ?? null;

      if (!pickup && !ret && groupRecords.length > 0) {
        setPickupInspection(groupRecords[0]);
        setReturnInspection(groupRecords[1] ?? null);
      } else {
        setPickupInspection(pickup);
        setReturnInspection(ret);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inspections.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const lineId = initialContractLineId ?? '';
    const aId = initialAssetId ?? '';
    if (lineId || aId) {
      setContractLineId(lineId);
      setAssetId(aId);
      fetchInspections(lineId, aId);
    }
  }, [initialContractLineId, initialAssetId, fetchInspections]);

  useEffect(() => () => {
    if (recapCopiedTimeoutRef.current != null) {
      window.clearTimeout(recapCopiedTimeoutRef.current);
    }
  }, []);

  const handleSearch = useCallback(() => {
    fetchInspections(contractLineId, assetId);
  }, [contractLineId, assetId, fetchInspections]);

  const deltaFlags = buildConditionDelta(pickupInspection, returnInspection);
  const checklistVariance = buildChecklistVariance(pickupInspection, returnInspection);
  const hasAnyInspection = pickupInspection || returnInspection;
  const shareText = buildCustomerRecapShareText(pickupInspection, returnInspection);
  const bundleAssetId =
    pickupInspection?.data.asset_id ??
    returnInspection?.data.asset_id ??
    initialAssetId ??
    (assetId.trim() || null);
  const bundleContractLineId =
    pickupInspection?.data.contract_line_id ??
    returnInspection?.data.contract_line_id ??
    initialContractLineId ??
    (contractLineId.trim() || null);
  const bundleScopeKey = buildScopeKey(
    bundleAssetId,
    bundleContractLineId,
    pickupInspection?.entityId ?? null,
    returnInspection?.entityId ?? null,
    initialWorkOrderId ?? null,
  );
  const releaseBlockingGaps = buildReleaseBlockingGaps(bundle, pickupInspection, returnInspection);
  const returnChecklistSummary = buildChecklistStatusSummary(returnInspection);

  useEffect(() => {
    if (!searched || !bundleScopeKey) {
      return;
    }

    setBundle(
      mergeBundle(
        bundleScopeKey,
        pickupInspection,
        returnInspection,
        bundleAssetId,
        bundleContractLineId,
        initialWorkOrderId ?? null,
      ),
    );
  }, [
    searched,
    bundleScopeKey,
    pickupInspection,
    returnInspection,
    bundleAssetId,
    bundleContractLineId,
    initialWorkOrderId,
  ]);

  useEffect(() => {
    persistBundle(bundle);
  }, [bundle]);

  const handleShareRecap = useCallback(async () => {
    setShowRecap(true);
    if (!shareText) {
      setRecapCopied(false);
      setRecapCopyError(null);
      return;
    }

    try {
      await navigator.clipboard.writeText(shareText);
      setRecapCopied(true);
      setRecapCopyError(null);
      if (recapCopiedTimeoutRef.current != null) {
        window.clearTimeout(recapCopiedTimeoutRef.current);
      }
      recapCopiedTimeoutRef.current = window.setTimeout(() => {
        setRecapCopied(false);
        recapCopiedTimeoutRef.current = null;
      }, 2000);
    } catch {
      setRecapCopied(false);
      setRecapCopyError('Clipboard access was unavailable. Review the recap below and copy it manually if needed.');
    }
  }, [shareText]);

  const appendBundleAudit = useCallback((currentBundle: InspectionEvidenceBundle, entry: EvidenceBundleAuditEntry) => ({
    ...currentBundle,
    updatedAt: entry.occurredAt,
    auditTrail: [entry, ...currentBundle.auditTrail].slice(0, MAX_BUNDLE_AUDIT_ENTRIES),
  }), []);

  const handleToggleRequiredInspection = useCallback(() => {
    setBundle((currentBundle) => {
      if (!currentBundle) return currentBundle;
      const occurredAt = new Date().toISOString();
      const nextPassed = !currentBundle.requiredInspectionPassed;
      return appendBundleAudit(
        {
          ...currentBundle,
          requiredInspectionPassed: nextPassed,
          releaseStatus: nextPassed ? currentBundle.releaseStatus : 'blocked',
        },
        createAuditEntry(
          nextPassed ? 'inspection_signed_off' : 'inspection_sign_off_reset',
          nextPassed ? 'Reviewer confirmed required inspections passed.' : 'Required inspection sign-off returned to pending.',
          currentBundle.reviewerName.trim() || null,
          occurredAt,
        ),
      );
    });
  }, [appendBundleAudit]);

  const handleToggleDeficiency = useCallback((deficiencyId: string) => {
    setBundle((currentBundle) => {
      if (!currentBundle) return currentBundle;

      const nextDeficiencies = currentBundle.deficiencies.map((deficiency) => {
        if (deficiency.id !== deficiencyId) return deficiency;

        const nextStatus = deficiency.status === 'open' ? 'resolved' : 'open';
        const occurredAt = new Date().toISOString();
        return {
          ...deficiency,
          status: nextStatus,
          resolvedAt: nextStatus === 'resolved' ? occurredAt : null,
          resolvedBy: nextStatus === 'resolved' ? currentBundle.reviewerName.trim() || null : null,
        };
      });

      const changedDeficiency = nextDeficiencies.find((deficiency) => deficiency.id === deficiencyId);
      if (!changedDeficiency) return currentBundle;

      return appendBundleAudit(
        {
          ...currentBundle,
          deficiencies: nextDeficiencies,
          releaseStatus: changedDeficiency.status === 'resolved' ? currentBundle.releaseStatus : 'blocked',
        },
        createAuditEntry(
          changedDeficiency.status === 'resolved' ? 'deficiency_resolved' : 'deficiency_reopened',
          `${changedDeficiency.label} marked ${changedDeficiency.status}.`,
          currentBundle.reviewerName.trim() || null,
        ),
      );
    });
  }, [appendBundleAudit]);

  const handleMarkRentReady = useCallback(() => {
    setBundle((currentBundle) => {
      if (!currentBundle) return currentBundle;

      const blockingGaps = buildReleaseBlockingGaps(currentBundle, pickupInspection, returnInspection);
      if (blockingGaps.length > 0) {
        return appendBundleAudit(
          {
            ...currentBundle,
            releaseStatus: 'blocked',
          },
          createAuditEntry(
            'release_blocked',
            `Rent-ready review blocked: ${blockingGaps.join(' ')}`,
            currentBundle.reviewerName.trim() || null,
          ),
        );
      }

      const occurredAt = new Date().toISOString();
      return appendBundleAudit(
        {
          ...currentBundle,
          releaseStatus: 'rent_ready',
          releaseReviewedAt: occurredAt,
        },
        createAuditEntry(
          'rent_ready_approved',
          'Reviewer marked the unit rent-ready.',
          currentBundle.reviewerName.trim() || null,
          occurredAt,
        ),
      );
    });
  }, [appendBundleAudit, pickupInspection, returnInspection]);

  const handleReopenRelease = useCallback(() => {
    setBundle((currentBundle) => {
      if (!currentBundle) return currentBundle;
      return appendBundleAudit(
        {
          ...currentBundle,
          releaseStatus: 'blocked',
          releaseReviewedAt: null,
        },
        createAuditEntry(
          'release_reopened',
          'Rent-ready approval was reopened for further review.',
          currentBundle.reviewerName.trim() || null,
        ),
      );
    });
  }, [appendBundleAudit]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ArrowLeftRight className="h-6 w-6" />
          Inspection Comparison
        </h1>
        <p className="text-muted-foreground text-sm">
          Compare pickup and return inspection evidence side by side. Generate a customer-safe
          recap in one action.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Load Inspections</CardTitle>
          <CardDescription>
            Enter a contract line ID or asset ID to load the associated inspection records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 space-y-1">
              <Label htmlFor="contract-line-id-input">Contract Line ID</Label>
              <Input
                id="contract-line-id-input"
                placeholder="UUID"
                value={contractLineId}
                onChange={(e) => setContractLineId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <div className="flex items-end pb-0.5">
              <span className="text-muted-foreground text-sm px-2">or</span>
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="asset-id-input">Asset ID</Label>
              <Input
                id="asset-id-input"
                placeholder="UUID"
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <div className="flex items-end">
              <Button onClick={handleSearch} disabled={loading}>
                {loading ? 'Loading…' : 'Load Inspections'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {searched && !loading && !error && (
        <>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <h2 className="text-lg font-semibold">Side-by-Side Comparison</h2>
              {hasAnyInspection && (
                <p className="text-sm text-muted-foreground">
                  Delta indicators show fields that changed between pickup and return.
                </p>
              )}
            </div>
            {hasAnyInspection && (
              <div className="space-y-1 text-right">
                <Button
                  onClick={handleShareRecap}
                  variant="outline"
                  className="gap-2"
                  aria-label="Share customer recap"
                >
                  <Share2 className="h-4 w-4" />
                  {recapCopied ? 'Copied Recap!' : 'Share Customer Recap'}
                </Button>
                {recapCopyError && (
                  <p role="alert" className="text-xs text-muted-foreground max-w-xs">{recapCopyError}</p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-6">
                <InspectionColumn
                  label="Pickup / Checkout"
                  inspection={pickupInspection}
                  deltaFlags={deltaFlags}
                  side="pickup"
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <InspectionColumn
                  label="Return"
                  inspection={returnInspection}
                  deltaFlags={deltaFlags}
                  side="return"
                />
              </CardContent>
            </Card>
          </div>

          {hasAnyInspection && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Condition Delta Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    {deltaFlags.outcomeChanged ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    )}
                    <span>Outcome {deltaFlags.outcomeChanged ? 'changed' : 'unchanged'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {deltaFlags.meterChanged ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    )}
                    <span>Meter {deltaFlags.meterChanged ? 'changed' : 'unchanged'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {deltaFlags.fuelChanged ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    )}
                    <span>Fuel {deltaFlags.fuelChanged ? 'changed' : 'unchanged'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {deltaFlags.photoCountChanged ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    )}
                    <span>Photo count {deltaFlags.photoCountChanged ? 'changed' : 'unchanged'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {deltaFlags.signatureChanged ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    )}
                    <span>Signature {deltaFlags.signatureChanged ? 'changed' : 'unchanged'}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {checklistVariance.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Checklist Variance
                </CardTitle>
                <CardDescription>
                  Per-item comparison across pickup and return inspections.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="divide-y text-sm" aria-label="Checklist variance">
                  {checklistVariance.map((v) => (
                    <div
                      key={v.item}
                      className="flex items-center gap-3 py-2"
                      aria-label={`Checklist item: ${v.item}`}
                    >
                      <span className="flex-1 font-medium">{v.item}</span>
                      <ChecklistStatusBadge status={v.pickupStatus} />
                      <ArrowLeftRight className="h-3 w-3 text-muted-foreground shrink-0" />
                      <ChecklistStatusBadge status={v.returnStatus} />
                      {v.changed && (
                        <Badge variant="destructive" className="text-xs ml-1">Changed</Badge>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {bundle && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Inspection Evidence Bundle
                </CardTitle>
                <CardDescription>
                  One scoped artifact carrying outbound context, return evidence, open deficiencies,
                  and explicit rent-ready approval.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-3 text-sm md:grid-cols-2">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scope</p>
                    <p className="mt-2">Asset: {bundle.assetId ?? '—'}</p>
                    <p>Contract line: {bundle.contractLineId ?? '—'}</p>
                    <p>Work order: {bundle.workOrderId ?? '—'}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Source audits</p>
                    <p className="mt-2">Pickup / checkout: {bundle.pickupInspectionId ?? 'Missing'}</p>
                    <p>Return: {bundle.returnInspectionId ?? 'Missing'}</p>
                    <p>
                      Return checklist: {returnChecklistSummary.pass} pass · {returnChecklistSummary.fail} fail · {returnChecklistSummary.na} N/A
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-medium">Open deficiencies</h3>
                      <p className="text-sm text-muted-foreground">
                        Failures from the return checklist stay blocked until a reviewer resolves them.
                      </p>
                    </div>
                    <Badge variant={bundle.deficiencies.some((deficiency) => deficiency.status === 'open') ? 'destructive' : 'outline'}>
                      {bundle.deficiencies.filter((deficiency) => deficiency.status === 'open').length} open
                    </Badge>
                  </div>
                  {bundle.deficiencies.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                      No failed checklist items are currently carrying forward as deficiencies.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {bundle.deficiencies.map((deficiency) => (
                        <div key={deficiency.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="font-medium">{deficiency.label}</p>
                            <p className="text-sm text-muted-foreground">
                              {deficiency.status === 'resolved'
                                ? `Resolved${deficiency.resolvedBy ? ` by ${deficiency.resolvedBy}` : ''}${deficiency.resolvedAt ? ` on ${new Date(deficiency.resolvedAt).toLocaleString()}` : ''}.`
                                : 'Still open from the return inspection.'}
                            </p>
                          </div>
                          <Button
                            variant={deficiency.status === 'resolved' ? 'outline' : 'secondary'}
                            onClick={() => handleToggleDeficiency(deficiency.id)}
                          >
                            {deficiency.status === 'resolved' ? 'Reopen deficiency' : 'Mark resolved'}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-medium">Rent-ready review</h3>
                      <p className="text-sm text-muted-foreground">
                        The system assembles the proof bundle, but the final release remains an explicit human approval.
                      </p>
                    </div>
                    <Badge variant={bundle.releaseStatus === 'rent_ready' && releaseBlockingGaps.length === 0 ? 'outline' : 'destructive'}>
                      {bundle.releaseStatus === 'rent_ready' && releaseBlockingGaps.length === 0 ? 'Rent-ready approved' : 'Blocked'}
                    </Badge>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="bundle-reviewer-name">Reviewer name</Label>
                      <Input
                        id="bundle-reviewer-name"
                        value={bundle.reviewerName}
                        onChange={(event) =>
                          setBundle((currentBundle) =>
                            currentBundle
                              ? {
                                  ...currentBundle,
                                  reviewerName: event.target.value,
                                  updatedAt: new Date().toISOString(),
                                }
                              : currentBundle,
                          )
                        }
                        placeholder="Service technician or approver"
                      />
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Required inspection sign-off</p>
                      <p className="text-sm text-muted-foreground">
                        {bundle.requiredInspectionPassed
                          ? 'Confirmed passed for final release.'
                          : 'Pending explicit final sign-off.'}
                      </p>
                      <Button variant="outline" onClick={handleToggleRequiredInspection}>
                        {bundle.requiredInspectionPassed ? 'Reset sign-off to pending' : 'Confirm required inspections passed'}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="bundle-release-notes">Release notes</Label>
                    <Textarea
                      id="bundle-release-notes"
                      value={bundle.releaseNotes}
                      onChange={(event) =>
                        setBundle((currentBundle) =>
                          currentBundle
                            ? {
                                ...currentBundle,
                                releaseNotes: event.target.value,
                                updatedAt: new Date().toISOString(),
                              }
                            : currentBundle,
                        )
                      }
                      placeholder="Capture what changed, what was repaired, and what was approved."
                    />
                  </div>

                  {releaseBlockingGaps.length > 0 && (
                    <Alert>
                      <AlertTitle>Blocked review state</AlertTitle>
                      <AlertDescription>
                        <ul className="list-disc space-y-1 pl-5">
                          {releaseBlockingGaps.map((gap) => (
                            <li key={gap}>{gap}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button onClick={handleMarkRentReady} disabled={releaseBlockingGaps.length > 0}>
                      Mark rent-ready
                    </Button>
                    <Button variant="outline" onClick={handleReopenRelease}>
                      Reopen review
                    </Button>
                    {bundle.releaseReviewedAt && (
                      <p className="self-center text-sm text-muted-foreground">
                        Approved {new Date(bundle.releaseReviewedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="font-medium">Audit trail</h3>
                  <div className="space-y-2" aria-label="Inspection evidence audit trail">
                    {bundle.auditTrail.map((entry) => (
                      <div key={entry.id} className="rounded-lg border p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{entry.event.replace(/_/g, ' ')}</Badge>
                          <span className="text-muted-foreground">{new Date(entry.occurredAt).toLocaleString()}</span>
                          {entry.actor && <span className="text-muted-foreground">by {entry.actor}</span>}
                        </div>
                        <p className="mt-2">{entry.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {showRecap && (
        <RecapModal
          pickupInspection={pickupInspection}
          returnInspection={returnInspection}
          onClose={() => setShowRecap(false)}
        />
      )}
    </div>
  );
}

function InspectionComparisonPage() {
  const { contract_line_id, asset_id, work_order_id } = Route.useSearch();
  return (
    <InspectionComparisonScreen
      initialContractLineId={contract_line_id}
      initialAssetId={asset_id}
      initialWorkOrderId={work_order_id}
    />
  );
}
