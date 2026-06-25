import { describe, expect, it } from 'vitest';

import {
  applyTelemetryComplianceUpdate,
  createTelemetryComplianceContractState,
  toDispatcherComplianceView,
  toDriverComplianceView,
  type NormalizedTelemetryComplianceSnapshot,
} from '@/lib/logistics-telemetry-contract';

function buildSnapshot(
  overrides: Partial<NormalizedTelemetryComplianceSnapshot> = {},
): NormalizedTelemetryComplianceSnapshot {
  return {
    assetId: 'asset-1',
    driverId: 'driver-1',
    routePosition: {
      latitude: 47.6205,
      longitude: -122.3493,
      recordedAt: '2026-01-01T10:00:00Z',
      speedMph: 42,
    },
    gpsStatus: 'online',
    eldDutyStatus: 'driving',
    complianceState: 'compliant',
    exceptions: [],
    observedAt: '2026-01-01T10:00:00Z',
    connectorKey: 'connector-a',
    ...overrides,
  };
}

describe('applyTelemetryComplianceUpdate', () => {
  it('applies normalized snapshots and resets retry state', () => {
    const state = createTelemetryComplianceContractState();
    const result = applyTelemetryComplianceUpdate(state, {
      dedupeKey: 'event-1',
      snapshot: buildSnapshot(),
    });

    expect(result.applied).toBe(true);
    expect(result.deduped).toBe(false);
    expect(result.state.latest?.assetId).toBe('asset-1');
    expect(result.state.syncStatus).toBe('synced');
    expect(result.state.retryCount).toBe(0);
  });

  it('dedupes repeated updates by dedupe key', () => {
    const first = applyTelemetryComplianceUpdate(createTelemetryComplianceContractState(), {
      dedupeKey: 'event-1',
      snapshot: buildSnapshot(),
    });
    const second = applyTelemetryComplianceUpdate(first.state, {
      dedupeKey: 'event-1',
      snapshot: buildSnapshot({ complianceState: 'violation' }),
    });

    expect(second.deduped).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.state.latest?.complianceState).toBe('compliant');
  });

  it('marks retrying on retryable sync failure', () => {
    const withSnapshot = applyTelemetryComplianceUpdate(createTelemetryComplianceContractState(), {
      dedupeKey: 'event-1',
      snapshot: buildSnapshot(),
    });
    const failed = applyTelemetryComplianceUpdate(withSnapshot.state, {
      dedupeKey: 'event-2',
      snapshot: null,
      syncFailure: {
        code: 'HTTP_503',
        message: 'connector unavailable',
        retryable: true,
        observedAt: '2026-01-01T10:01:00Z',
      },
    });

    expect(failed.state.syncStatus).toBe('retrying');
    expect(failed.state.retryCount).toBe(1);
    expect(failed.state.lastFailure?.code).toBe('HTTP_503');
    expect(failed.state.latest?.assetId).toBe('asset-1');
  });

  it('marks failed when retries are exhausted', () => {
    const base = applyTelemetryComplianceUpdate(createTelemetryComplianceContractState(), {
      dedupeKey: 'event-1',
      snapshot: buildSnapshot(),
    });
    const retry1 = applyTelemetryComplianceUpdate(
      { ...base.state, retryCount: 2, syncStatus: 'retrying' },
      {
        dedupeKey: 'event-2',
        snapshot: null,
        syncFailure: {
          code: 'HTTP_503',
          message: 'connector unavailable',
          retryable: true,
          observedAt: '2026-01-01T10:02:00Z',
        },
      },
      2,
    );

    expect(retry1.state.syncStatus).toBe('failed');
    expect(retry1.state.retryCount).toBe(2);
  });
});

describe('status mappers', () => {
  it('returns vendor-agnostic dispatcher and driver views from normalized contract', () => {
    const a = applyTelemetryComplianceUpdate(createTelemetryComplianceContractState(), {
      dedupeKey: 'event-1',
      snapshot: buildSnapshot({
        connectorKey: 'vendor-a',
        complianceState: 'approaching_limit',
        exceptions: [{ type: 'missing_logs', occurredAt: '2026-01-01T10:03:00Z', description: 'missing log block' }],
      }),
    }).state;
    const b = applyTelemetryComplianceUpdate(createTelemetryComplianceContractState(), {
      dedupeKey: 'event-1',
      snapshot: buildSnapshot({
        connectorKey: 'vendor-b',
        complianceState: 'approaching_limit',
        exceptions: [{ type: 'missing_logs', occurredAt: '2026-01-01T10:03:00Z', description: 'missing log block' }],
      }),
    }).state;

    expect(toDispatcherComplianceView(a)).toEqual(toDispatcherComplianceView(b));
    expect(toDriverComplianceView(a)).toEqual(toDriverComplianceView(b));
  });
});
