export type NormalizedGpsStatus = 'online' | 'stale' | 'offline' | 'unknown';

export type NormalizedEldDutyStatus = 'driving' | 'on_duty_not_driving' | 'off_duty' | 'sleeper_berth' | 'unknown';

export type DriverLogComplianceState = 'compliant' | 'approaching_limit' | 'violation' | 'device_malfunction' | 'unknown';

export type ComplianceExceptionType =
  | 'hos_violation'
  | 'missing_logs'
  | 'unassigned_drive_time'
  | 'eld_disconnect'
  | 'unknown';

export interface RoutePosition {
  latitude: number;
  longitude: number;
  recordedAt: string;
  headingDegrees?: number;
  speedMph?: number;
}

export interface ComplianceExceptionEvent {
  type: ComplianceExceptionType;
  occurredAt: string;
  description: string;
}

export interface NormalizedTelemetryComplianceSnapshot {
  assetId: string;
  driverId: string;
  routePosition: RoutePosition | null;
  gpsStatus: NormalizedGpsStatus;
  eldDutyStatus: NormalizedEldDutyStatus;
  complianceState: DriverLogComplianceState;
  exceptions: ComplianceExceptionEvent[];
  observedAt: string;
  connectorKey: string;
}

export type SyncStatus = 'synced' | 'retrying' | 'failed';

export interface SyncFailure {
  code: string;
  message: string;
  retryable: boolean;
  observedAt: string;
}

export interface TelemetryComplianceContractState {
  latest: NormalizedTelemetryComplianceSnapshot | null;
  syncStatus: SyncStatus;
  retryCount: number;
  lastFailure: SyncFailure | null;
  processedDedupeKeys: string[];
}

export interface TelemetryComplianceUpdate {
  dedupeKey: string;
  snapshot: NormalizedTelemetryComplianceSnapshot | null;
  syncFailure?: SyncFailure;
}

export interface TelemetryContractApplyResult {
  state: TelemetryComplianceContractState;
  deduped: boolean;
  applied: boolean;
}

export interface DispatcherComplianceView {
  positionSummary: string;
  complianceSummary: string;
  severity: 'normal' | 'warning' | 'critical';
}

export interface DriverComplianceView {
  gpsSummary: string;
  dutySummary: string;
  complianceSummary: string;
  blocking: boolean;
}

// Keep enough history to absorb bursty connector retries while bounding client memory.
const MAX_DEDUPE_KEYS = 200;

export function createTelemetryComplianceContractState(): TelemetryComplianceContractState {
  return {
    latest: null,
    syncStatus: 'synced',
    retryCount: 0,
    lastFailure: null,
    processedDedupeKeys: [],
  };
}

export function applyTelemetryComplianceUpdate(
  current: TelemetryComplianceContractState,
  update: TelemetryComplianceUpdate,
  maxRetries = 3,
): TelemetryContractApplyResult {
  if (current.processedDedupeKeys.includes(update.dedupeKey)) {
    return { state: current, deduped: true, applied: false };
  }

  const nextKeys = appendDedupeKey(current.processedDedupeKeys, update.dedupeKey);

  if (update.syncFailure) {
    const nextRetryCount = update.syncFailure.retryable ? current.retryCount + 1 : current.retryCount;
    const shouldRetry = update.syncFailure.retryable && nextRetryCount <= maxRetries;
    return {
      state: {
        ...current,
        syncStatus: shouldRetry ? 'retrying' : 'failed',
        retryCount: shouldRetry ? nextRetryCount : current.retryCount,
        lastFailure: update.syncFailure,
        processedDedupeKeys: nextKeys,
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

  return {
    state: {
      latest: update.snapshot,
      syncStatus: 'synced',
      retryCount: 0,
      lastFailure: null,
      processedDedupeKeys: nextKeys,
    },
    deduped: false,
    applied: true,
  };
}

export function toDispatcherComplianceView(state: TelemetryComplianceContractState): DispatcherComplianceView {
  const latest = state.latest;
  if (!latest) {
    return {
      positionSummary: state.syncStatus === 'failed' ? 'Position unavailable (sync failed)' : 'Position unavailable',
      complianceSummary: state.syncStatus === 'failed' ? 'Compliance unavailable (sync failed)' : 'Compliance unavailable',
      severity: state.syncStatus === 'failed' ? 'critical' : 'warning',
    };
  }

  const severity = toSeverity(latest.complianceState, latest.exceptions);
  return {
    positionSummary: latest.routePosition
      ? `${latest.routePosition.latitude.toFixed(4)}, ${latest.routePosition.longitude.toFixed(4)}`
      : 'No GPS fix',
    complianceSummary: summarizeCompliance(latest.complianceState, latest.exceptions.length),
    severity,
  };
}

export function toDriverComplianceView(state: TelemetryComplianceContractState): DriverComplianceView {
  const latest = state.latest;
  if (!latest) {
    return {
      gpsSummary: state.syncStatus === 'failed' ? 'GPS data unavailable' : 'Waiting for GPS',
      dutySummary: 'Duty status unavailable',
      complianceSummary: 'Compliance unavailable',
      blocking: state.syncStatus === 'failed',
    };
  }

  const blocking = latest.complianceState === 'violation' || latest.complianceState === 'device_malfunction';
  return {
    gpsSummary: latest.gpsStatus === 'online' ? 'GPS online' : `GPS ${latest.gpsStatus.replace('_', ' ')}`,
    dutySummary: `ELD ${latest.eldDutyStatus.replace(/_/g, ' ')}`,
    complianceSummary: summarizeCompliance(latest.complianceState, latest.exceptions.length),
    blocking,
  };
}

function appendDedupeKey(current: string[], key: string): string[] {
  const next = [...current, key];
  if (next.length <= MAX_DEDUPE_KEYS) {
    return next;
  }
  return next.slice(next.length - MAX_DEDUPE_KEYS);
}

function summarizeCompliance(state: DriverLogComplianceState, exceptionCount: number): string {
  const suffix = exceptionCount > 0 ? ` (${exceptionCount} exception${exceptionCount > 1 ? 's' : ''})` : '';
  if (state === 'approaching_limit') return `Approaching limit${suffix}`;
  if (state === 'violation') return `Violation${suffix}`;
  if (state === 'device_malfunction') return `ELD malfunction${suffix}`;
  if (state === 'compliant') return `Compliant${suffix}`;
  return `Unknown${suffix}`;
}

function toSeverity(
  complianceState: DriverLogComplianceState,
  exceptions: ComplianceExceptionEvent[],
): DispatcherComplianceView['severity'] {
  if (complianceState === 'violation' || complianceState === 'device_malfunction') return 'critical';
  if (complianceState === 'approaching_limit' || exceptions.length > 0) return 'warning';
  return 'normal';
}
