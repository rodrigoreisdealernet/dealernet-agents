import type {
  ConflictAssistantEvidence,
  ConflictAssistantItem,
  ConflictAssistantResult,
} from './bookingConflictAssistant';

export const DISPATCH_LOOKOUT_TAGS = [
  'market-logistics-dispatcher:t2',
  'market-logistics-dispatcher:t3',
  'market-logistics-dispatcher:t4',
] as const;

interface DispatchRouteSignal {
  line_id?: unknown;
  contract_id?: unknown;
  asset_id?: unknown;
  asset_name?: unknown;
  route_status?: unknown;
  exception_state?: unknown;
  branch_id?: unknown;
  assigned_driver?: unknown;
  assigned_truck?: unknown;
  telemetry_position_status?: unknown;
  telemetry_event_at?: unknown;
  telemetry_sync_status?: unknown;
  eld_compliance_status?: unknown;
  driver_log_status?: unknown;
}

interface ContractLineSignal {
  entity_id?: unknown;
  contract_id?: unknown;
  status?: unknown;
  asset_id?: unknown;
  category_id?: unknown;
  actual_end?: unknown;
  data?: unknown;
}

interface ContractSignal {
  id?: unknown;
  entity_versions?: unknown;
}

interface AvailabilitySignal {
  branch_id?: unknown;
  branch_name?: unknown;
  asset_category_id?: unknown;
  asset_category_name?: unknown;
  available_assets?: unknown;
  unavailable_assets?: unknown;
  maintenance_due_assets?: unknown;
  maintenance_overdue_assets?: unknown;
  soft_down_assets?: unknown;
  hard_down_assets?: unknown;
}

type LooseRecord = Record<string, unknown>;
type RankedConflictItem = ConflictAssistantItem & { impactScore: number };

const LOOKAHEAD_DAYS = 2;
const MS_PER_DAY = 1_000 * 60 * 60 * 24;
const PRIORITY_RANKS: Record<ConflictAssistantItem['priority'], number> = {
  blocking: 0,
  review: 1,
  warning: 2,
  no_op: 3,
};
const STATUS_RANKS: Record<ConflictAssistantItem['status'], number> = {
  conflict: 0,
  uncertain: 1,
  follow_up: 2,
  no_op: 3,
};

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysUntil(value: string | undefined, today: string): number | null {
  const target = parseDate(value);
  const baseline = parseDate(today);
  if (!target || !baseline) return null;
  return Math.floor((target.getTime() - baseline.getTime()) / MS_PER_DAY);
}

function availabilityKey(branchId: string | undefined, categoryId: string | undefined): string | null {
  if (!branchId || !categoryId) return null;
  return `${branchId}::${categoryId}`;
}

function contractVersionData(contract: ContractSignal | null): LooseRecord | null {
  const version = asRecord(asArray(contract?.entity_versions)[0]);
  return asRecord(version?.data);
}

function describeAvailability(row: AvailabilitySignal | undefined): string {
  if (!row) {
    return 'Current branch/category coverage is missing from the live capacity feed.';
  }
  const available = asNumber(row.available_assets) ?? 0;
  const unavailable = asNumber(row.unavailable_assets) ?? 0;
  const due = asNumber(row.maintenance_due_assets) ?? 0;
  const overdue = asNumber(row.maintenance_overdue_assets) ?? 0;
  const softDown = asNumber(row.soft_down_assets) ?? 0;
  const hardDown = asNumber(row.hard_down_assets) ?? 0;
  const scope = [asString(row.branch_name) || asString(row.branch_id), asString(row.asset_category_name) || asString(row.asset_category_id)]
    .filter(Boolean)
    .join(' · ');
  return `${scope || 'Current branch/category'} shows ${available} available, ${unavailable} unavailable, ${due} due maintenance, ${overdue} overdue maintenance, ${softDown} soft-down, and ${hardDown} hard-down units.`;
}

function coordinationPath(branchId: string | undefined, driver: string | undefined, includeHaulerReview = false): string {
  const branchStep = `Branch ${branchId || 'dispatch'} coordinator`;
  const driverStep = driver ? `Driver ${driver}` : 'Route driver';
  const steps = [driverStep, branchStep];
  if (includeHaulerReview) steps.push('manual outside-haul review');
  return steps.join(' → ');
}

function priorityRank(priority: ConflictAssistantItem['priority']): number {
  return PRIORITY_RANKS[priority];
}

function statusRank(status: ConflictAssistantItem['status']): number {
  return STATUS_RANKS[status];
}

function threadKey(item: ConflictAssistantItem): string {
  return item.lineId || item.contractId || item.id;
}

function buildNoOpResult(summary: string): ConflictAssistantResult {
  return {
    noOp: true,
    tags: DISPATCH_LOOKOUT_TAGS,
    items: [{
      id: 'no-op',
      workflow: 'dispatch',
      priority: 'no_op',
      status: 'no_op',
      title: 'No materially new dispatch conflict',
      summary,
      recommendation: 'Human approval still governs any resequencing, outside-haul spend, status change, or customer promise adjustment.',
      requiresHumanApproval: true,
      evidence: [{
        source: 'route',
        label: 'Lookout state',
        detail: 'Live route, return, telemetry, and capacity signals do not currently show a materially new dispatch conflict.',
      }],
    }],
  };
}

function sortItems(items: RankedConflictItem[]): ConflictAssistantItem[] {
  return [...items]
    .sort((left, right) => {
      const priorityDelta = priorityRank(left.priority) - priorityRank(right.priority);
      if (priorityDelta !== 0) return priorityDelta;
      if (left.impactScore !== right.impactScore) return right.impactScore - left.impactScore;
      return left.title.localeCompare(right.title);
    })
    .map((item) => {
      const { impactScore, ...rest } = item;
      void impactScore;
      return rest;
    });
}

export function buildDispatchConflictLookout(input: {
  routes?: unknown;
  lines?: unknown;
  contracts?: unknown;
  availability?: unknown;
  today?: string;
}): ConflictAssistantResult {
  const routes = asArray(input.routes) as DispatchRouteSignal[];
  const lines = asArray(input.lines) as ContractLineSignal[];
  const contracts = asArray(input.contracts) as ContractSignal[];
  const availability = asArray(input.availability) as AvailabilitySignal[];
  const today = input.today || new Date().toISOString().slice(0, 10);

  const contractById = new Map<string, ContractSignal>();
  contracts.forEach((contract) => {
    const id = asString(contract.id);
    if (id) contractById.set(id, contract);
  });

  const availabilityByKey = new Map<string, AvailabilitySignal>();
  availability.forEach((row) => {
    const key = availabilityKey(asString(row.branch_id), asString(row.asset_category_id));
    if (key) availabilityByKey.set(key, row);
  });

  const routeByLineId = new Map<string, DispatchRouteSignal>();
  routes.forEach((route) => {
    const lineId = asString(route.line_id);
    if (lineId) routeByLineId.set(lineId, route);
  });

  const futureGroups = new Map<string, {
    branchId?: string;
    categoryId?: string;
    contractNumbers: Set<string>;
    lines: ContractLineSignal[];
  }>();
  const returnCandidates: Array<{
    line: ContractLineSignal;
    branchId?: string;
    categoryId?: string;
    contractId?: string;
    contractNumber: string;
    orderId?: string;
    plannedEnd?: string;
    lineId?: string;
    route?: DispatchRouteSignal;
  }> = [];
  const contractBlockerCandidates: Array<{
    contractId?: string;
    contractNumber: string;
    orderId?: string;
    lineId?: string;
    branchId?: string;
    status?: string;
    blockerReason?: string;
  }> = [];

  for (const line of lines) {
    const lineId = asString(line.entity_id);
    const contractId = asString(line.contract_id);
    const status = asString(line.status);
    const categoryId = asString(line.category_id);
    const lineData = asRecord(line.data);
    const contract = contractId ? contractById.get(contractId) || null : null;
    const contractData = contractVersionData(contract);
    const branchId = asString(contractData?.branch_id);
    const contractNumber = asString(contractData?.contract_number) || contractId || lineId || 'contract';
    const orderId = asString(contractData?.order_id);

    if (status === 'pending_execution') {
      const plannedStart = asString(lineData?.planned_start);
      const daysToStart = daysUntil(plannedStart, today);
      if (daysToStart !== null && daysToStart <= LOOKAHEAD_DAYS) {
        const key = availabilityKey(branchId, categoryId);
        if (key) {
          const group = futureGroups.get(key) || {
            branchId,
            categoryId,
            contractNumbers: new Set<string>(),
            lines: [],
          };
          group.contractNumbers.add(contractNumber);
          group.lines.push(line);
          futureGroups.set(key, group);
        }
      }

      const contractStatus = asString(contractData?.status)?.toLowerCase();
      const blockerReason = asString(lineData?.dispatch_blocker_reason)
        || asString(lineData?.blocker_reason)
        || asString(contractData?.dispatch_blocker_reason)
        || asString(contractData?.blocker_reason);
      const blockedByStatus = Boolean(contractStatus) && !['active', 'confirmed', 'open'].includes(contractStatus);
      if (blockedByStatus || blockerReason) {
        contractBlockerCandidates.push({
          contractId,
          contractNumber,
          orderId,
          lineId,
          branchId,
          status: contractStatus,
          blockerReason,
        });
      }
    }

    if (status === 'checked_out' && !asString(line.actual_end)) {
      const plannedEnd = asString(lineData?.planned_end);
      const daysToEnd = daysUntil(plannedEnd, today);
      if (daysToEnd !== null && daysToEnd <= LOOKAHEAD_DAYS) {
        returnCandidates.push({
          line,
          branchId,
          categoryId,
          contractId,
          contractNumber,
          orderId,
          plannedEnd,
          lineId,
          route: lineId ? routeByLineId.get(lineId) : undefined,
        });
      }
    }
  }

  const items: RankedConflictItem[] = [];

  routes.forEach((route) => {
    const lineId = asString(route.line_id);
    const contractId = asString(route.contract_id);
    const branchId = asString(route.branch_id);
    const contractData = contractVersionData(contractId ? contractById.get(contractId) || null : null);
    const contractNumber = asString(contractData?.contract_number) || contractId || lineId || 'contract';
    const orderId = asString(contractData?.order_id);
    const driver = asString(route.assigned_driver);
    const routeStatus = asString(route.route_status) || 'unknown';
    const exceptionState = asString(route.exception_state);
    const telemetryStatus = asString(route.telemetry_position_status);
    const telemetryEventAt = asString(route.telemetry_event_at);
    const telemetrySyncStatus = asString(route.telemetry_sync_status);
    const eldStatus = asString(route.eld_compliance_status);
    const driverLogStatus = asString(route.driver_log_status);
    const assetName = asString(route.asset_name) || lineId || 'route';
    const uncertainTelemetry = telemetryStatus === 'stale'
      || telemetryStatus === 'missing'
      || telemetrySyncStatus === 'retryable_failure'
      || telemetrySyncStatus === 'rejected'
      || telemetrySyncStatus === 'unknown';

    if (exceptionState === 'overdue' || exceptionState === 'missing_driver' || eldStatus === 'violation' || driverLogStatus === 'out_of_hours') {
      const evidence: ConflictAssistantEvidence[] = [{
        source: 'route',
        label: 'Route signal',
        detail: `${assetName} is currently ${routeStatus}${exceptionState ? ` with ${exceptionState.replace('_', ' ')}` : ''}.`,
      }, {
        source: 'telemetry',
        label: 'Telemetry / compliance',
        detail: `GPS is ${telemetryStatus || 'unknown'}, sync is ${telemetrySyncStatus || 'unknown'}, ELD is ${eldStatus || 'unknown'}, and driver log status is ${driverLogStatus || 'unknown'}${telemetryEventAt ? ` (last event ${telemetryEventAt})` : ''}.`,
      }, {
        source: 'route',
        label: 'Coordination path',
        detail: coordinationPath(branchId, driver, false),
      }];

      if (uncertainTelemetry && exceptionState !== 'overdue') {
        evidence.push({
          source: 'uncertainty',
          label: 'Uncertainty',
          detail: 'Telemetry is degraded, so the dispatcher should confirm the route state directly with the driver before escalating any downstream promise changes.',
        });
      }

      items.push({
        id: `dispatch-route-${lineId || contractId || assetName}`,
        workflow: 'dispatch',
        priority: exceptionState === 'overdue' || eldStatus === 'violation' || driverLogStatus === 'out_of_hours' ? 'blocking' : 'review',
        status: exceptionState === 'overdue' || eldStatus === 'violation' || driverLogStatus === 'out_of_hours' ? 'conflict' : 'follow_up',
        title: `Route slippage watch for ${contractNumber}`,
        summary: 'The live board shows a route issue that can force manual dispatch recovery if it is not coordinated now.',
        recommendation: exceptionState === 'missing_driver'
          ? 'Confirm the driver assignment with the branch before resequencing any dependent work.'
          : 'Confirm ETA, route status, and the next branch handoff now. Any promise changes or outside-haul spend remain human-approved.',
        requiresHumanApproval: true,
        orderId,
        contractId,
        lineId,
        evidence,
        impactScore: exceptionState === 'overdue' ? 3 : 2,
      });
    } else if (uncertainTelemetry) {
      items.push({
        id: `dispatch-uncertain-${lineId || contractId || assetName}`,
        workflow: 'dispatch',
        priority: 'review',
        status: 'uncertain',
        title: `Telemetry ambiguity for ${contractNumber}`,
        summary: 'Live telemetry is stale or degraded enough that the dispatcher cannot tell whether this is a real route conflict or a feed gap.',
        recommendation: 'Escalate to manual dispatcher review and confirm the driver ETA before resequencing, changing a promise, or involving an outside hauler.',
        requiresHumanApproval: true,
        orderId,
        contractId,
        lineId,
        evidence: [{
          source: 'telemetry',
          label: 'Telemetry status',
          detail: `GPS is ${telemetryStatus || 'unknown'} and sync is ${telemetrySyncStatus || 'unknown'}${telemetryEventAt ? ` (last event ${telemetryEventAt})` : ''}.`,
        }, {
          source: 'route',
          label: 'Coordination path',
          detail: coordinationPath(branchId, driver, false),
        }],
        impactScore: 1,
      });
    }
  });

  contractBlockerCandidates.forEach((candidate) => {
    items.push({
      id: `dispatch-contract-blocker-${candidate.lineId || candidate.contractId || candidate.contractNumber}`,
      workflow: 'dispatch',
      priority: 'blocking',
      status: 'follow_up',
      title: `Contract readiness blocker for ${candidate.contractNumber}`,
      summary: 'A same-day dispatch line is close to execution while contract readiness remains blocked.',
      recommendation: 'Coordinate counter/service contract resolution first, then proceed with any replan path. Outside-haul, customer promise, and status-changing steps remain human-approved.',
      requiresHumanApproval: true,
      orderId: candidate.orderId,
      contractId: candidate.contractId,
      lineId: candidate.lineId,
      evidence: [{
        source: 'open_contract',
        label: 'Contract readiness',
        detail: `Contract state is ${candidate.status || 'unknown'}${candidate.blockerReason ? ` with blocker "${candidate.blockerReason}"` : ''}.`,
      }, {
        source: 'route',
        label: 'Coordination path',
        detail: coordinationPath(candidate.branchId, undefined, false),
      }],
      impactScore: 3,
    });
  });

  const handledCapacityKeys = new Set<string>();

  returnCandidates.forEach((candidate) => {
    const key = availabilityKey(candidate.branchId, candidate.categoryId);
    const futureGroup = key ? futureGroups.get(key) : undefined;
    const futureDemand = futureGroup?.lines.length ?? 0;
    const availabilityRow = key ? availabilityByKey.get(key) : undefined;
    const availableAssets = availabilityRow ? asNumber(availabilityRow.available_assets) ?? 0 : undefined;
    const daysToEnd = daysUntil(candidate.plannedEnd, today) ?? 0;
    const telemetryStatus = asString(candidate.route?.telemetry_position_status);
    const telemetrySyncStatus = asString(candidate.route?.telemetry_sync_status);
    const uncertainTelemetry = telemetryStatus === 'stale'
      || telemetryStatus === 'missing'
      || telemetrySyncStatus === 'retryable_failure'
      || telemetrySyncStatus === 'rejected'
      || telemetrySyncStatus === 'unknown';

    if (futureDemand === 0 && daysToEnd >= 0) return;

    const evidence: ConflictAssistantEvidence[] = [{
      source: 'return',
      label: 'Return signal',
      detail: `${candidate.contractNumber} is due back ${candidate.plannedEnd || 'soon'} and is still checked out.`,
    }];

    if (futureDemand > 0) {
      evidence.push({
        source: 'capacity',
        label: 'Future order queue',
        detail: `${futureDemand} upcoming dispatch line${futureDemand !== 1 ? 's' : ''} for the same branch/category are already inside the next ${LOOKAHEAD_DAYS}-day window (${Array.from(futureGroup?.contractNumbers || []).join(', ')}).`,
      });
    }

    if (availabilityRow) {
      evidence.push({
        source: 'availability',
        label: 'Capacity signal',
        detail: describeAvailability(availabilityRow),
      });
    } else {
      evidence.push({
        source: 'uncertainty',
        label: 'Capacity confidence',
        detail: 'The current branch/category capacity signal is missing, so the dispatcher must verify whether a real downstream shortage exists.',
      });
    }

    evidence.push({
      source: 'route',
      label: 'Coordination path',
      detail: coordinationPath(candidate.branchId, asString(candidate.route?.assigned_driver), futureDemand > 0),
    });

    let priority: ConflictAssistantItem['priority'] = daysToEnd < 0 ? 'blocking' : 'review';
    let status: ConflictAssistantItem['status'] = daysToEnd < 0 ? 'conflict' : 'follow_up';
    let recommendation = 'Confirm the driver ETA and branch recovery plan before committing any resequencing, promise change, or outside-haul spend.';

    if (!availabilityRow || (uncertainTelemetry && daysToEnd >= 0)) {
      status = 'uncertain';
      recommendation = 'Escalate to manual dispatcher review because telemetry or capacity coverage is incomplete for this return decision.';
    } else if (availableAssets !== undefined && futureDemand > availableAssets) {
      priority = 'blocking';
      status = 'conflict';
      recommendation = 'Expedite return coordination now. Any outside-haul, promise, or status-changing recovery still needs human approval.';
    }

    items.push({
      id: `dispatch-return-${candidate.lineId || candidate.contractId || candidate.contractNumber}`,
      workflow: 'dispatch',
      priority,
      status,
      title: `Late-return risk for ${candidate.contractNumber}`,
      summary: futureDemand > 0
        ? 'A checked-out asset is colliding with upcoming dispatch demand in the same branch/category.'
        : 'A checked-out asset is overdue and needs immediate dispatcher follow-up.',
      recommendation,
      requiresHumanApproval: true,
      orderId: candidate.orderId,
      contractId: candidate.contractId,
      lineId: candidate.lineId,
      evidence,
      impactScore: Math.max(futureDemand, 1),
    });

    if (key) handledCapacityKeys.add(key);
  });

  futureGroups.forEach((group, key) => {
    if (handledCapacityKeys.has(key)) return;
    const availabilityRow = availabilityByKey.get(key);
    const availableAssets = availabilityRow ? asNumber(availabilityRow.available_assets) ?? 0 : undefined;
    const demand = group.lines.length;

    if (availabilityRow && (availableAssets ?? 0) >= demand) return;

    const contractNumbers = Array.from(group.contractNumbers);
    items.push({
      id: `dispatch-capacity-${key}`,
      workflow: 'dispatch',
      priority: availableAssets === 0 ? 'blocking' : 'review',
      status: availabilityRow ? 'conflict' : 'uncertain',
      title: `Future-order capacity conflict for ${contractNumbers[0] || group.categoryId || 'dispatch queue'}`,
      summary: 'Upcoming dispatch demand exceeds what the live branch/category capacity signal can currently cover.',
      recommendation: availabilityRow
        ? 'Review branch resequencing options first. Any outside-haul decision or customer-facing change stays human-approved.'
        : 'Capacity coverage is incomplete; verify the branch position manually before escalating this queue conflict.',
      requiresHumanApproval: true,
      contractId: asString(group.lines[0]?.contract_id),
      lineId: asString(group.lines[0]?.entity_id),
      evidence: [{
        source: 'capacity',
        label: 'Future order queue',
        detail: `${demand} dispatch line${demand !== 1 ? 's' : ''} are due inside the next ${LOOKAHEAD_DAYS}-day window (${contractNumbers.join(', ')}).`,
      }, {
        source: availabilityRow ? 'availability' : 'uncertainty',
        label: availabilityRow ? 'Capacity signal' : 'Capacity confidence',
        detail: availabilityRow ? describeAvailability(availabilityRow) : 'No matching branch/category capacity row is available in the current live feed.',
      }, {
        source: 'route',
        label: 'Coordination path',
        detail: coordinationPath(group.branchId, undefined, true),
      }],
      impactScore: demand,
    });
  });

  const threadedItemsByKey = new Map<string, RankedConflictItem>();
  const evidenceKeysByThread = new Map<string, Set<string>>();
  for (const item of items) {
    const key = threadKey(item);
    const existing = threadedItemsByKey.get(key);
    if (!existing) {
      threadedItemsByKey.set(key, item);
      evidenceKeysByThread.set(key, new Set(item.evidence.map((e) => `${e.label}::${e.detail}`)));
      continue;
    }
    let mergedSignals = false;
    let replacedPrimaryContext = false;

    if (priorityRank(item.priority) < priorityRank(existing.priority)) {
      existing.priority = item.priority;
      existing.title = item.title;
      existing.recommendation = item.recommendation;
      replacedPrimaryContext = true;
      mergedSignals = true;
    }
    if (statusRank(item.status) < statusRank(existing.status)) {
      existing.status = item.status;
      if (!replacedPrimaryContext) {
        existing.title = item.title;
        existing.recommendation = item.recommendation;
      }
      mergedSignals = true;
    }
    if (item.impactScore > existing.impactScore) {
      existing.impactScore = item.impactScore;
      mergedSignals = true;
    }
    const existingEvidence = evidenceKeysByThread.get(key) || new Set<string>();
    item.evidence.forEach((e) => {
      const evidenceKey = `${e.label}::${e.detail}`;
      if (!existingEvidence.has(evidenceKey)) {
        existing.evidence.push(e);
        existingEvidence.add(evidenceKey);
        mergedSignals = true;
      }
    });
    evidenceKeysByThread.set(key, existingEvidence);
    const distinctSources = new Set(existing.evidence.map((e) => e.source));
    if (mergedSignals && distinctSources.size > 1) {
      existing.summary = 'Combined market dispatch recovery thread across dwell, blocker, telemetry, and capacity signals.';
    }
  }
  const threadedItems = Array.from(threadedItemsByKey.values());

  if (threadedItems.length === 0) {
    return buildNoOpResult('The market dispatch recovery brief does not currently show a materially new dwell, contract blocker, telemetry, or same-day capacity exception.');
  }

  return {
    items: sortItems(threadedItems),
    noOp: false,
    tags: DISPATCH_LOOKOUT_TAGS,
  };
}
