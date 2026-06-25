// Coupa sync observability contract
//
// Provides a Coupa-specific state model for procurement sync delivery,
// retry tracking, dead-letter handling, disable controls, and operator-facing
// diagnostics.
//
// Related: issues #1145, #892, #483; docs/specs/coupa-observability-reconciliation.md

export type CoupaSyncStatus =
  | 'attempted'
  | 'synced'
  | 'retrying'
  | 'dead_lettered'
  | 'quarantined'
  | 'replayed'
  | 'disabled';

export type CoupaFailureClass =
  | 'auth'
  | 'mapping'
  | 'provider_policy'
  | 'rate_limit'
  | 'timeout'
  | 'duplicate'
  | 'validation'
  | 'workflow'
  | 'unknown';

export type CoupaObjectType = 'requisition' | 'purchase_order' | 'supplier' | 'invoice';
export type CoupaSyncDirection = 'inbound' | 'outbound';

export interface CoupaSyncFailure {
  failureClass: CoupaFailureClass;
  failureCode: string;
  message: string;
  retryable: boolean;
  observedAt: string;
}

export interface CoupaSyncSnapshot {
  providerName: 'coupa';
  objectType: CoupaObjectType;
  objectKey: string;
  internalRecordId?: string;
  coupaRecordId?: string;
  direction: CoupaSyncDirection;
  syncStatus: CoupaSyncStatus;
  retryCount: number;
  maxRetries: number;
  sourceSystem: string;
  sourceEventId: string;
  correlationId?: string;
  occurredAt: string;
  resolvedAt?: string;
  failure?: CoupaSyncFailure;
}

export interface CoupaSyncContractState {
  latest: CoupaSyncSnapshot | null;
  syncStatus: CoupaSyncStatus;
  retryCount: number;
  lastFailure: CoupaSyncFailure | null;
  processedDedupeKeys: string[];
  deadLettered: boolean;
  quarantined: boolean;
  disabled: boolean;
}

export interface CoupaSyncUpdate {
  dedupeKey: string;
  snapshot: CoupaSyncSnapshot | null;
  failure?: CoupaSyncFailure;
}

export interface CoupaSyncApplyResult {
  state: CoupaSyncContractState;
  deduped: boolean;
  applied: boolean;
}

export interface OperatorSyncView {
  statusSummary: string;
  failureSummary: string;
  severity: 'ok' | 'warning' | 'critical';
  actionRequired: boolean;
  suggestedAction: string | null;
}

const MAX_DEDUPE_KEYS = 200;

export function createCoupaSyncState(): CoupaSyncContractState {
  return {
    latest: null,
    syncStatus: 'attempted',
    retryCount: 0,
    lastFailure: null,
    processedDedupeKeys: [],
    deadLettered: false,
    quarantined: false,
    disabled: false,
  };
}

export function applyCoupaSyncUpdate(
  current: CoupaSyncContractState,
  update: CoupaSyncUpdate,
  maxRetries = 3,
): CoupaSyncApplyResult {
  if (current.processedDedupeKeys.includes(update.dedupeKey)) {
    return { state: current, deduped: true, applied: false };
  }

  const nextKeys = appendDedupeKey(current.processedDedupeKeys, update.dedupeKey);

  if (update.failure) {
    const nextRetryCount = update.failure.retryable ? current.retryCount + 1 : current.retryCount;
    const retriesExhausted = update.failure.retryable && nextRetryCount > maxRetries;
    const deadLettered = retriesExhausted || !update.failure.retryable;
    const nextStatus: CoupaSyncStatus = deadLettered ? 'dead_lettered' : 'retrying';

    return {
      state: {
        ...current,
        syncStatus: nextStatus,
        retryCount: update.failure.retryable ? nextRetryCount : current.retryCount,
        lastFailure: update.failure,
        processedDedupeKeys: nextKeys,
        deadLettered,
        quarantined: current.quarantined,
        disabled: current.disabled,
      },
      deduped: false,
      applied: false,
    };
  }

  if (!update.snapshot) {
    return {
      state: {
        ...current,
        processedDedupeKeys: nextKeys,
      },
      deduped: false,
      applied: false,
    };
  }

  const { syncStatus } = update.snapshot;

  return {
    state: {
      latest: update.snapshot,
      syncStatus,
      retryCount: update.snapshot.retryCount,
      lastFailure: null,
      processedDedupeKeys: nextKeys,
      deadLettered: syncStatus === 'dead_lettered',
      quarantined: syncStatus === 'quarantined',
      disabled: syncStatus === 'disabled',
    },
    deduped: false,
    applied: true,
  };
}

export function toOperatorSyncView(state: CoupaSyncContractState): OperatorSyncView {
  const { syncStatus, lastFailure, deadLettered, quarantined, disabled } = state;

  if (!state.latest && syncStatus === 'attempted') {
    return {
      statusSummary: 'Awaiting Coupa sync confirmation',
      failureSummary: 'No failure recorded',
      severity: 'ok',
      actionRequired: false,
      suggestedAction: null,
    };
  }

  if (disabled) {
    return {
      statusSummary: 'Sync scope disabled by operator',
      failureSummary: lastFailure ? describeFailure(lastFailure) : 'Scope paused pending recovery',
      severity: 'critical',
      actionRequired: true,
      suggestedAction: 'Re-enable the scope after the root cause is resolved and drift is reviewed',
    };
  }

  if (quarantined) {
    return {
      statusSummary: 'Sync event quarantined by operator',
      failureSummary: lastFailure
        ? describeFailure(lastFailure)
        : 'Manually quarantined — inspect DLQ notes before replay',
      severity: 'critical',
      actionRequired: true,
      suggestedAction: 'Review the dead-letter entry, then replay if the Coupa-side issue is fixed',
    };
  }

  if (deadLettered) {
    return {
      statusSummary: 'Sync dead-lettered after retries',
      failureSummary: lastFailure ? describeFailure(lastFailure) : 'Unknown failure',
      severity: 'critical',
      actionRequired: true,
      suggestedAction: suggestAction(lastFailure?.failureClass ?? null),
    };
  }

  if (syncStatus === 'retrying') {
    return {
      statusSummary: `Retrying Coupa sync (attempt ${state.retryCount})`,
      failureSummary: lastFailure ? describeFailure(lastFailure) : 'Transient failure',
      severity: 'warning',
      actionRequired: false,
      suggestedAction: null,
    };
  }

  if (syncStatus === 'synced' || syncStatus === 'replayed') {
    return {
      statusSummary: syncStatus === 'replayed' ? 'Synced via replay' : 'Synced',
      failureSummary: 'No active failure',
      severity: 'ok',
      actionRequired: false,
      suggestedAction: null,
    };
  }

  return {
    statusSummary: `Status: ${syncStatus}`,
    failureSummary: lastFailure ? describeFailure(lastFailure) : 'No failure recorded',
    severity: 'warning',
    actionRequired: false,
    suggestedAction: null,
  };
}

export function diagnoseCoupaFailure(failureClass: CoupaFailureClass | null): string {
  switch (failureClass) {
    case 'auth':
      return 'Authentication failure: verify Coupa API credentials, token refresh state, and secret references';
    case 'mapping':
      return 'Mapping failure: inspect the procurement object mapping for missing or renamed Coupa fields';
    case 'provider_policy':
      return 'Provider policy rejection: review approval rules, supplier policy gates, and Coupa-side validation';
    case 'rate_limit':
      return 'Rate limit exceeded: reduce connector concurrency or widen the Coupa polling interval';
    case 'timeout':
      return 'Request timed out: check provider latency, outbound network health, and retry backoff';
    case 'duplicate':
      return 'Duplicate object detected: confirm idempotency keys and reconcile whether Coupa already applied the write';
    case 'validation':
      return 'Validation failure: compare the payload against the latest Coupa schema and required fields';
    case 'workflow':
      return 'Workflow failure: inspect connector orchestration state and resume the disabled scope only when it is safe';
    default:
      return 'Unknown failure: inspect connector diagnostics and reconciliation drift details';
  }
}

function describeFailure(failure: CoupaSyncFailure): string {
  return `[${failure.failureClass}] ${failure.failureCode}: ${failure.message}`;
}

function suggestAction(failureClass: CoupaFailureClass | null): string {
  switch (failureClass) {
    case 'auth':
      return 'Rotate or refresh Coupa credentials, then replay eligible dead-letter entries';
    case 'mapping':
      return 'Fix the procurement mapping, review drifted objects, then replay the failed sync';
    case 'provider_policy':
      return 'Correct the Coupa policy violation or approval state before retrying';
    case 'rate_limit':
      return 'Throttle the connector and retry after the Coupa rate-limit window resets';
    case 'timeout':
      return 'Check provider/network health and retry when latency returns to normal';
    case 'duplicate':
      return 'Verify whether Coupa already accepted the object before replaying';
    case 'validation':
      return 'Repair the invalid payload and run reconciliation before replay';
    case 'workflow':
      return 'Re-enable the disabled scope only after the connector workflow state is healthy';
    default:
      return 'Inspect reconciliation diagnostics and connector logs before retrying';
  }
}

function appendDedupeKey(keys: string[], next: string): string[] {
  const withNext = [...keys, next];
  return withNext.length > MAX_DEDUPE_KEYS
    ? withNext.slice(withNext.length - MAX_DEDUPE_KEYS)
    : withNext;
}
