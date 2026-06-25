import type { ConflictAssistantEvidence, ConflictAssistantItem, ConflictAssistantResult } from '@/lib/bookingConflictAssistant';

export const PORTAL_REQUEST_OPERATING_MODEL_TAGS = [
  'rental-customer-portal-user:t2',
  'rental-customer-portal-user:t3',
  'rental-customer-portal-user:t6',
] as const;

type LooseRecord = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeUrgency(value: string | undefined): 'critical' | 'high' | 'standard' | 'low' {
  if (value === 'critical' || value === 'high' || value === 'low') return value;
  return 'standard';
}

function urgencyRank(value: string | undefined): number {
  const urgency = normalizeUrgency(value);
  if (urgency === 'critical') return 0;
  if (urgency === 'high') return 1;
  if (urgency === 'standard') return 2;
  return 3;
}

function requestTypeLabel(type: string): string {
  if (type === 'contract_extension') return 'Extension';
  if (type === 'field_service') return 'Field service';
  return 'Pickup / call-off';
}

function workflowForRequestType(type: string): ConflictAssistantItem['workflow'] {
  if (type === 'contract_extension') return 'extension';
  return 'dispatch';
}

function recommendationForRequestType(type: string): string {
  if (type === 'contract_extension') {
    return 'Validate extension terms and branch availability, then confirm follow-up with the customer manually.';
  }
  if (type === 'field_service') {
    return 'Triage service urgency and evidence, then dispatch only after human branch approval.';
  }
  return 'Review pickup/call-off readiness with contract and equipment context before manually scheduling.';
}

export function buildCustomerPortalRequestQueue(input: {
  contracts?: unknown;
  lines?: unknown;
  customerRequests?: unknown;
}): ConflictAssistantResult {
  const contractRows = asArray(input.contracts).map((value) => asRecord(value)).filter(Boolean) as LooseRecord[];
  const lineRows = asArray(input.lines).map((value) => asRecord(value)).filter(Boolean) as LooseRecord[];
  const requestRows = asArray(input.customerRequests).map((value) => asRecord(value)).filter(Boolean) as LooseRecord[];

  const contractLabelById = new Map<string, string>();
  for (const contractRow of contractRows) {
    const id = asString(contractRow.id);
    const versions = asArray(contractRow.entity_versions);
    const versionData = asRecord(asRecord(versions[0])?.data);
    if (!id) continue;
    contractLabelById.set(id, asString(versionData?.contract_number) ?? id);
  }

  const lineContextById = new Map<string, { assetId?: string; jobSiteId?: string }>();
  for (const lineRow of lineRows) {
    const lineId = asString(lineRow.entity_id);
    if (!lineId) continue;
    lineContextById.set(lineId, {
      assetId: asString(lineRow.asset_id),
      jobSiteId: asString(asRecord(lineRow.data)?.job_site_id),
    });
  }

  const canonicalByKey = new Map<string, LooseRecord>();
  for (const requestRow of requestRows) {
    const requestId = asString(requestRow.id);
    const versions = asArray(requestRow.entity_versions);
    const version = asRecord(versions[0]);
    const data = asRecord(version?.data);
    if (!requestId || !data) continue;
    if (asString(data.source) !== 'portal_schedule') continue;

    const status = asString(data.status) ?? 'requested';
    if (status === 'completed' || status === 'cancelled' || status === 'closed') continue;

    const contractId = asString(data.contract_id);
    const lineId = asString(data.contract_line_id);
    const requestType = asString(data.request_type) ?? 'off_rent_pickup';
    if (!contractId || !lineId) continue;

    const key = `${contractId}:${lineId}:${requestType}`;
    const existing = canonicalByKey.get(key);
    const existingVersionData = asRecord(asRecord(asArray(existing?.entity_versions)[0])?.data);
    const existingSignal = asString(existingVersionData?.latest_signal_at)
      ?? asString(existingVersionData?.requested_at)
      ?? '';
    const currentSignal = asString(data.latest_signal_at) ?? asString(data.requested_at) ?? '';
    if (!existing || currentSignal > existingSignal) {
      canonicalByKey.set(key, requestRow);
    }
  }

  const items: ConflictAssistantItem[] = Array.from(canonicalByKey.values()).map((requestRow) => {
    const versions = asArray(requestRow.entity_versions);
    const data = asRecord(asRecord(versions[0])?.data) || {};
    const contractId = asString(data.contract_id);
    const lineId = asString(data.contract_line_id);
    const requestType = asString(data.request_type) ?? 'off_rent_pickup';
    const urgency = normalizeUrgency(asString(data.urgency));
    const reason = asString(data.reason) ?? 'Customer requested branch follow-up from the portal.';
    const note = asString(data.customer_note);
    const evidenceGaps = asArray(data.evidence_gaps).map((value) => asString(value)).filter(Boolean) as string[];
    const contractLabel = contractId ? contractLabelById.get(contractId) ?? contractId : 'Unknown contract';
    const lineContext = lineId ? lineContextById.get(lineId) : undefined;
    const assetId = asString(data.asset_id) ?? lineContext?.assetId;
    const jobSiteId = asString(data.job_site_id) ?? lineContext?.jobSiteId;

    const evidence: ConflictAssistantEvidence[] = [
      { source: 'open_contract', label: 'Customer request', detail: reason },
      { source: 'open_contract', label: 'Urgency', detail: urgency },
    ];
    if (assetId || jobSiteId) {
      evidence.push({
        source: 'open_contract',
        label: 'Contract / equipment context',
        detail: `Asset ${assetId ?? 'unknown'} · Job site ${jobSiteId ?? 'unknown'}`,
      });
    }
    if (note) {
      evidence.push({ source: 'open_contract', label: 'Customer note', detail: note });
    }
    if (evidenceGaps.length > 0) {
      evidence.push({
        source: 'uncertainty',
        label: 'Evidence gaps',
        detail: evidenceGaps.join(', '),
      });
    }

    return {
      id: asString(requestRow.id) ?? `${contractId ?? 'unknown'}-${lineId ?? 'unknown'}-${requestType}`,
      workflow: workflowForRequestType(requestType),
      priority: urgency === 'critical' ? 'blocking' : urgency === 'high' ? 'review' : 'warning',
      status: evidenceGaps.length > 0 ? 'uncertain' : 'follow_up',
      title: `${requestTypeLabel(requestType)} review for ${contractLabel}`,
      summary: `Customer portal request requires branch review (${urgency} urgency) before any dispatch, extension, or status action.`,
      recommendation: asString(data.recommended_disposition) ?? recommendationForRequestType(requestType),
      requiresHumanApproval: true,
      contractId,
      lineId,
      evidence,
    };
  });

  const sortedItems = items
    .map((item) => ({
      item,
      urgency: item.evidence.find((entry) => entry.label === 'Urgency')?.detail,
    }))
    .sort((left, right) => {
      const urgencyDelta = urgencyRank(left.urgency) - urgencyRank(right.urgency);
      if (urgencyDelta !== 0) return urgencyDelta;
      return left.item.title.localeCompare(right.item.title);
    })
    .map((entry) => entry.item);

  if (sortedItems.length === 0) {
    return {
      noOp: true,
      tags: PORTAL_REQUEST_OPERATING_MODEL_TAGS,
      items: [
        {
          id: 'customer-request-no-op',
          workflow: 'no_op',
          priority: 'no_op',
          status: 'no_op',
          title: 'No open customer portal requests',
          summary: 'No active pickup, extension, or field-service requests are waiting in the branch queue.',
          recommendation: 'Human approval remains required for all customer-facing outcomes.',
          requiresHumanApproval: true,
          evidence: [
            {
              source: 'open_contract',
              label: 'Queue state',
              detail: 'No open portal schedule requests with pending branch action were found.',
            },
          ],
        },
      ],
    };
  }

  return {
    noOp: false,
    tags: PORTAL_REQUEST_OPERATING_MODEL_TAGS,
    items: sortedItems,
  };
}
