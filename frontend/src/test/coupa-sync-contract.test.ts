import { describe, expect, it } from 'vitest';

import {
  applyCoupaSyncUpdate,
  createCoupaSyncState,
  diagnoseCoupaFailure,
  toOperatorSyncView,
  type CoupaSyncFailure,
  type CoupaSyncSnapshot,
} from '@/lib/coupa-sync-contract';

function buildSnapshot(
  overrides: Partial<CoupaSyncSnapshot> = {},
): CoupaSyncSnapshot {
  return {
    providerName: 'coupa',
    objectType: 'requisition',
    objectKey: 'REQ-100',
    internalRecordId: 'internal-req-100',
    coupaRecordId: 'coupa-req-100',
    direction: 'outbound',
    syncStatus: 'synced',
    retryCount: 0,
    maxRetries: 3,
    sourceSystem: 'coupa',
    sourceEventId: 'src-coupa-001',
    correlationId: 'corr-coupa-001',
    occurredAt: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

function buildFailure(
  overrides: Partial<CoupaSyncFailure> = {},
): CoupaSyncFailure {
  return {
    failureClass: 'auth',
    failureCode: 'OAUTH_401',
    message: 'token expired',
    retryable: true,
    observedAt: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

describe('applyCoupaSyncUpdate', () => {
  it('applies a synced snapshot and resets retry state', () => {
    const result = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ syncStatus: 'synced' }),
    });

    expect(result.applied).toBe(true);
    expect(result.state.syncStatus).toBe('synced');
    expect(result.state.retryCount).toBe(0);
    expect(result.state.deadLettered).toBe(false);
  });

  it('records retrying status on retryable failure', () => {
    const result = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: null,
      failure: buildFailure({ retryable: true }),
    });

    expect(result.state.syncStatus).toBe('retrying');
    expect(result.state.retryCount).toBe(1);
    expect(result.state.deadLettered).toBe(false);
  });

  it('dead-letters on non-retryable failure', () => {
    const result = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: null,
      failure: buildFailure({ failureClass: 'mapping', failureCode: 'FIELD_MISSING', retryable: false }),
    });

    expect(result.state.syncStatus).toBe('dead_lettered');
    expect(result.state.deadLettered).toBe(true);
  });

  it('tracks disabled snapshots from operator controls', () => {
    const result = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ objectType: 'supplier', objectKey: 'SUP-300', syncStatus: 'disabled' }),
    });

    expect(result.state.syncStatus).toBe('disabled');
    expect(result.state.disabled).toBe(true);
    expect(result.state.quarantined).toBe(false);
  });

  it('dedupes repeated updates by dedupe key', () => {
    const first = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot(),
    });
    const second = applyCoupaSyncUpdate(first.state, {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ syncStatus: 'retrying' }),
    });

    expect(second.deduped).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.state.syncStatus).toBe('synced');
  });
});

describe('toOperatorSyncView', () => {
  it('returns ok severity for a synced object', () => {
    const state = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ syncStatus: 'synced' }),
    }).state;

    const view = toOperatorSyncView(state);
    expect(view.severity).toBe('ok');
    expect(view.actionRequired).toBe(false);
  });

  it('returns critical severity for a dead-lettered object', () => {
    const state = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: null,
      failure: buildFailure({ failureClass: 'auth', retryable: false }),
    }).state;

    const view = toOperatorSyncView(state);
    expect(view.severity).toBe('critical');
    expect(view.suggestedAction).toContain('credentials');
  });

  it('returns critical severity for a quarantined object', () => {
    const state = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ syncStatus: 'quarantined' }),
    }).state;

    const view = toOperatorSyncView(state);
    expect(view.severity).toBe('critical');
    expect(view.actionRequired).toBe(true);
  });

  it('returns critical severity for a disabled scope', () => {
    const state = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ objectType: 'supplier', objectKey: 'SUP-300', syncStatus: 'disabled' }),
    }).state;

    const view = toOperatorSyncView(state);
    expect(view.severity).toBe('critical');
    expect(view.statusSummary).toContain('disabled');
    expect(view.actionRequired).toBe(true);
  });

  it('returns ok severity for a replayed object', () => {
    const state = applyCoupaSyncUpdate(createCoupaSyncState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ syncStatus: 'replayed' }),
    }).state;

    const view = toOperatorSyncView(state);
    expect(view.severity).toBe('ok');
    expect(view.statusSummary).toContain('replay');
  });
});

describe('diagnoseCoupaFailure', () => {
  it('returns Coupa-specific guidance for auth failures', () => {
    expect(diagnoseCoupaFailure('auth')).toContain('Coupa API credentials');
  });

  it('returns Coupa-specific guidance for workflow failures', () => {
    expect(diagnoseCoupaFailure('workflow')).toContain('disabled scope');
  });
});
