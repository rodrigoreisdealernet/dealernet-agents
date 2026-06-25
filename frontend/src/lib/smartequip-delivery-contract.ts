// SmartEquip delivery observability contract
//
// Provides a vendor-agnostic state model for SmartEquip API exchange delivery,
// retry tracking, dead-letter handling, and operator-facing diagnostics.
//
// Related: issues #1156, #892, #482; docs/specs/smartequip-observability-recovery.md

export type SmartEquipDeliveryStatus =
  | 'attempted'
  | 'delivered'
  | 'retrying'
  | 'dead_lettered'
  | 'quarantined'
  | 'replayed';

export type SmartEquipFailureClass =
  | 'auth'
  | 'signature'
  | 'mapping'
  | 'provider_policy'
  | 'rate_limit'
  | 'timeout'
  | 'duplicate'
  | 'schema_validation'
  | 'unknown';

export type SmartEquipExchangeDirection = 'inbound' | 'outbound';

export interface SmartEquipDeliveryFailure {
  failureClass: SmartEquipFailureClass;
  failureCode: string;
  message: string;
  retryable: boolean;
  observedAt: string;
}

export interface SmartEquipExchangeSnapshot {
  exchangeId: string;
  flowName: string;
  direction: SmartEquipExchangeDirection;
  deliveryStatus: SmartEquipDeliveryStatus;
  retryCount: number;
  maxRetries: number;
  sourceSystem: string;
  sourceEventId: string;
  correlationId?: string;
  occurredAt: string;
  resolvedAt?: string;
  failure?: SmartEquipDeliveryFailure;
}

export interface SmartEquipDeliveryContractState {
  latest: SmartEquipExchangeSnapshot | null;
  deliveryStatus: SmartEquipDeliveryStatus;
  retryCount: number;
  lastFailure: SmartEquipDeliveryFailure | null;
  processedDedupeKeys: string[];
  deadLettered: boolean;
  quarantined: boolean;
}

export interface SmartEquipDeliveryUpdate {
  dedupeKey: string;
  snapshot: SmartEquipExchangeSnapshot | null;
  failure?: SmartEquipDeliveryFailure;
}

export interface SmartEquipDeliveryApplyResult {
  state: SmartEquipDeliveryContractState;
  deduped: boolean;
  applied: boolean;
}

export interface OperatorDeliveryView {
  statusSummary: string;
  failureSummary: string;
  severity: 'ok' | 'warning' | 'critical';
  actionRequired: boolean;
  suggestedAction: string | null;
}

// Bound dedupe-key history to avoid unbounded client memory growth.
const MAX_DEDUPE_KEYS = 200;

export function createSmartEquipDeliveryState(): SmartEquipDeliveryContractState {
  return {
    latest: null,
    deliveryStatus: 'attempted',
    retryCount: 0,
    lastFailure: null,
    processedDedupeKeys: [],
    deadLettered: false,
    quarantined: false,
  };
}

export function applySmartEquipDeliveryUpdate(
  current: SmartEquipDeliveryContractState,
  update: SmartEquipDeliveryUpdate,
  maxRetries = 3,
): SmartEquipDeliveryApplyResult {
  if (current.processedDedupeKeys.includes(update.dedupeKey)) {
    return { state: current, deduped: true, applied: false };
  }

  const nextKeys = appendDedupeKey(current.processedDedupeKeys, update.dedupeKey);

  if (update.failure) {
    const nextRetryCount = update.failure.retryable ? current.retryCount + 1 : current.retryCount;
    // maxRetries counts retry attempts (not total attempts), so dead-letter once we exceed it.
    const retriesExhausted = update.failure.retryable && nextRetryCount > maxRetries;
    const deadLettered = retriesExhausted || !update.failure.retryable;
    const newStatus: SmartEquipDeliveryStatus = deadLettered
      ? 'dead_lettered'
      : update.failure.retryable
      ? 'retrying'
      : 'dead_lettered';

    return {
      state: {
        ...current,
        deliveryStatus: newStatus,
        retryCount: update.failure.retryable ? nextRetryCount : current.retryCount,
        lastFailure: update.failure,
        processedDedupeKeys: nextKeys,
        deadLettered,
        quarantined: current.quarantined,
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

  const isQuarantined = update.snapshot.deliveryStatus === 'quarantined';
  const isDeadLettered = update.snapshot.deliveryStatus === 'dead_lettered';

  return {
    state: {
      latest: update.snapshot,
      deliveryStatus: update.snapshot.deliveryStatus,
      retryCount: update.snapshot.retryCount,
      lastFailure: null,
      processedDedupeKeys: nextKeys,
      deadLettered: isDeadLettered,
      quarantined: isQuarantined,
    },
    deduped: false,
    applied: true,
  };
}

export function toOperatorDeliveryView(state: SmartEquipDeliveryContractState): OperatorDeliveryView {
  const { deliveryStatus, lastFailure, deadLettered, quarantined } = state;

  if (!state.latest && deliveryStatus === 'attempted') {
    return {
      statusSummary: 'Awaiting delivery confirmation',
      failureSummary: 'No failure recorded',
      severity: 'ok',
      actionRequired: false,
      suggestedAction: null,
    };
  }

  if (quarantined) {
    return {
      statusSummary: 'Exchange quarantined by operator',
      failureSummary: lastFailure
        ? describeFailure(lastFailure)
        : 'Manually quarantined — see operator notes',
      severity: 'critical',
      actionRequired: true,
      suggestedAction: 'Review quarantine reason; replay if failure class is resolved',
    };
  }

  if (deadLettered) {
    const failureSummary = lastFailure ? describeFailure(lastFailure) : 'Unknown failure';
    return {
      statusSummary: 'Exchange dead-lettered after exhausting retries',
      failureSummary,
      severity: 'critical',
      actionRequired: true,
      suggestedAction: suggestAction(lastFailure?.failureClass ?? null),
    };
  }

  if (deliveryStatus === 'retrying') {
    return {
      statusSummary: `Retrying (attempt ${state.retryCount})`,
      failureSummary: lastFailure ? describeFailure(lastFailure) : 'Transient failure',
      severity: 'warning',
      actionRequired: false,
      suggestedAction: null,
    };
  }

  if (deliveryStatus === 'delivered' || deliveryStatus === 'replayed') {
    return {
      statusSummary: deliveryStatus === 'replayed' ? 'Delivered via replay' : 'Delivered',
      failureSummary: 'No active failure',
      severity: 'ok',
      actionRequired: false,
      suggestedAction: null,
    };
  }

  return {
    statusSummary: `Status: ${deliveryStatus}`,
    failureSummary: lastFailure ? describeFailure(lastFailure) : 'No failure recorded',
    severity: 'warning',
    actionRequired: false,
    suggestedAction: null,
  };
}

export function diagnoseSmartEquipFailure(failureClass: SmartEquipFailureClass | null): string {
  switch (failureClass) {
    case 'auth':
      return 'Authentication failure: verify OAuth credentials, token expiry, and connector auth config';
    case 'signature':
      return 'Signature verification failed: check HMAC secret rotation, payload encoding, and clock skew';
    case 'mapping':
      return 'Payload mapping error: inspect field-level transform logs for missing or mistyped fields';
    case 'provider_policy':
      return 'Provider policy rejection: review rate limits, IP allowlists, and API version compatibility';
    case 'rate_limit':
      return 'Rate limit exceeded: check throttle config and back-off intervals in the connector';
    case 'timeout':
      return 'Delivery timeout: check provider latency, network path, and Temporal activity heartbeat';
    case 'duplicate':
      return 'Duplicate exchange detected: verify idempotency key generation and dedupe table';
    case 'schema_validation':
      return 'Schema validation failure: check payload structure against the current API contract';
    default:
      return 'Unknown failure: review raw connector logs for details';
  }
}

function describeFailure(failure: SmartEquipDeliveryFailure): string {
  return `[${failure.failureClass}] ${failure.failureCode}: ${failure.message}`;
}

function suggestAction(failureClass: SmartEquipFailureClass | null): string {
  switch (failureClass) {
    case 'auth':
      return 'Rotate or refresh OAuth credentials, then mark DLQ entry as replay-eligible';
    case 'signature':
      return 'Confirm HMAC secret is in sync with provider, then replay';
    case 'mapping':
      return 'Fix field mapping configuration in the connector, then replay';
    case 'provider_policy':
      return 'Resolve policy issue with the provider (allowlist, version), then replay';
    case 'duplicate':
      return 'Verify this exchange was already processed; quarantine if confirmed duplicate';
    default:
      return 'Investigate failure logs, then replay or quarantine as appropriate';
  }
}

function appendDedupeKey(current: string[], key: string): string[] {
  const next = [...current, key];
  if (next.length <= MAX_DEDUPE_KEYS) {
    return next;
  }
  return next.slice(next.length - MAX_DEDUPE_KEYS);
}
