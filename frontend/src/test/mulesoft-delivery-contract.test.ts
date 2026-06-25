import { describe, expect, it } from 'vitest';

import {
  applyMulesoftDeliveryUpdate,
  createMulesoftDeliveryState,
  diagnoseMulesoftFailure,
  toOperatorDeliveryView,
  type MulesoftDeliveryFailure,
  type MulesoftExchangeSnapshot,
} from '@/lib/mulesoft-delivery-contract';

function buildSnapshot(
  overrides: Partial<MulesoftExchangeSnapshot> = {},
): MulesoftExchangeSnapshot {
  return {
    exchangeId: 'exchange-001',
    flowName: 'rental-order-sync',
    direction: 'outbound',
    deliveryStatus: 'delivered',
    retryCount: 0,
    maxRetries: 3,
    sourceSystem: 'mulesoft',
    sourceEventId: 'src-event-001',
    correlationId: 'corr-001',
    occurredAt: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

function buildFailure(
  overrides: Partial<MulesoftDeliveryFailure> = {},
): MulesoftDeliveryFailure {
  return {
    failureClass: 'auth',
    failureCode: 'OAUTH_401',
    message: 'token expired',
    retryable: true,
    observedAt: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

describe('applyMulesoftDeliveryUpdate — event emission', () => {
  it('applies a delivered snapshot and resets retry state', () => {
    const state = createMulesoftDeliveryState();
    const result = applyMulesoftDeliveryUpdate(state, {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'delivered' }),
    });

    expect(result.applied).toBe(true);
    expect(result.deduped).toBe(false);
    expect(result.state.deliveryStatus).toBe('delivered');
    expect(result.state.retryCount).toBe(0);
    expect(result.state.lastFailure).toBeNull();
    expect(result.state.deadLettered).toBe(false);
    expect(result.state.quarantined).toBe(false);
  });

  it('records retrying status on retryable failure', () => {
    const state = createMulesoftDeliveryState();
    const result = applyMulesoftDeliveryUpdate(state, {
      dedupeKey: 'evt-1',
      snapshot: null,
      failure: buildFailure({ retryable: true }),
    });

    expect(result.state.deliveryStatus).toBe('retrying');
    expect(result.state.retryCount).toBe(1);
    expect(result.state.lastFailure?.failureCode).toBe('OAUTH_401');
    expect(result.state.deadLettered).toBe(false);
  });

  it('dead-letters on non-retryable failure', () => {
    const state = createMulesoftDeliveryState();
    const result = applyMulesoftDeliveryUpdate(state, {
      dedupeKey: 'evt-1',
      snapshot: null,
      failure: buildFailure({
        failureClass: 'mapping',
        failureCode: 'MAP_FIELD_MISSING',
        retryable: false,
      }),
    });

    expect(result.state.deliveryStatus).toBe('dead_lettered');
    expect(result.state.deadLettered).toBe(true);
    expect(result.state.lastFailure?.failureClass).toBe('mapping');
  });
});

describe('applyMulesoftDeliveryUpdate — dedupe', () => {
  it('dedupes repeated updates by dedupe key', () => {
    const first = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot(),
    });
    const second = applyMulesoftDeliveryUpdate(first.state, {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'retrying' }),
    });

    expect(second.deduped).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.state.deliveryStatus).toBe('delivered');
  });

  it('processes a distinct dedupe key after a duplicate', () => {
    const first = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'retrying', retryCount: 1 }),
    });
    const second = applyMulesoftDeliveryUpdate(first.state, {
      dedupeKey: 'evt-2',
      snapshot: buildSnapshot({ deliveryStatus: 'delivered', retryCount: 0 }),
    });

    expect(second.deduped).toBe(false);
    expect(second.applied).toBe(true);
    expect(second.state.deliveryStatus).toBe('delivered');
  });
});

describe('applyMulesoftDeliveryUpdate — retry exhaustion → dead letter', () => {
  it('dead-letters when retries are exhausted', () => {
    const base = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'retrying', retryCount: 3 }),
    });
    const exhausted = applyMulesoftDeliveryUpdate(
      { ...base.state, retryCount: 3, deliveryStatus: 'retrying' },
      {
        dedupeKey: 'evt-2',
        snapshot: null,
        failure: buildFailure({ retryable: true }),
      },
      3,
    );

    expect(exhausted.state.deliveryStatus).toBe('dead_lettered');
    expect(exhausted.state.deadLettered).toBe(true);
  });

  it('preserves latest snapshot when transitioning to dead_lettered', () => {
    const withSnapshot = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'retrying' }),
    });
    const exhausted = applyMulesoftDeliveryUpdate(
      { ...withSnapshot.state, retryCount: 3, deliveryStatus: 'retrying' },
      {
        dedupeKey: 'evt-2',
        snapshot: null,
        failure: buildFailure({ retryable: true }),
      },
      3,
    );

    expect(exhausted.state.latest?.exchangeId).toBe('exchange-001');
    expect(exhausted.state.deadLettered).toBe(true);
  });
});

describe('applyMulesoftDeliveryUpdate — quarantine and replay', () => {
  it('reflects quarantined status from snapshot', () => {
    const result = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'quarantined' }),
    });

    expect(result.state.quarantined).toBe(true);
    expect(result.state.deliveryStatus).toBe('quarantined');
  });

  it('reflects replayed status and clears failure', () => {
    const result = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'replayed' }),
    });

    expect(result.state.deliveryStatus).toBe('replayed');
    expect(result.state.lastFailure).toBeNull();
  });
});

describe('toOperatorDeliveryView', () => {
  it('returns ok severity for a delivered exchange', () => {
    const state = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'delivered' }),
    }).state;

    const view = toOperatorDeliveryView(state);
    expect(view.severity).toBe('ok');
    expect(view.actionRequired).toBe(false);
    expect(view.suggestedAction).toBeNull();
  });

  it('returns critical severity with action for a dead-lettered exchange', () => {
    const state = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: null,
      failure: buildFailure({ failureClass: 'auth', retryable: false }),
    }).state;

    const view = toOperatorDeliveryView(state);
    expect(view.severity).toBe('critical');
    expect(view.actionRequired).toBe(true);
    expect(view.suggestedAction).toContain('OAuth');
  });

  it('returns critical severity for a quarantined exchange', () => {
    const state = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'quarantined' }),
    }).state;

    const view = toOperatorDeliveryView(state);
    expect(view.severity).toBe('critical');
    expect(view.actionRequired).toBe(true);
  });

  it('returns warning severity while retrying', () => {
    const state = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: null,
      failure: buildFailure({ retryable: true }),
    }).state;

    const view = toOperatorDeliveryView(state);
    expect(view.severity).toBe('warning');
    expect(view.actionRequired).toBe(false);
  });

  it('returns ok severity for a replayed exchange', () => {
    const state = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ deliveryStatus: 'replayed' }),
    }).state;

    const view = toOperatorDeliveryView(state);
    expect(view.severity).toBe('ok');
    expect(view.statusSummary).toContain('replay');
  });

  it('returns identical views for equivalent snapshots regardless of source system', () => {
    const stateA = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ sourceSystem: 'mulesoft-prod', deliveryStatus: 'delivered' }),
    }).state;
    const stateB = applyMulesoftDeliveryUpdate(createMulesoftDeliveryState(), {
      dedupeKey: 'evt-1',
      snapshot: buildSnapshot({ sourceSystem: 'mulesoft-staging', deliveryStatus: 'delivered' }),
    }).state;

    expect(toOperatorDeliveryView(stateA).severity).toEqual(toOperatorDeliveryView(stateB).severity);
    expect(toOperatorDeliveryView(stateA).actionRequired).toEqual(
      toOperatorDeliveryView(stateB).actionRequired,
    );
  });
});

describe('diagnoseMulesoftFailure', () => {
  it('provides auth diagnosis', () => {
    expect(diagnoseMulesoftFailure('auth')).toContain('OAuth');
  });

  it('provides signature diagnosis', () => {
    expect(diagnoseMulesoftFailure('signature')).toContain('HMAC');
  });

  it('provides mapping diagnosis', () => {
    expect(diagnoseMulesoftFailure('mapping')).toContain('transform');
  });

  it('provides provider_policy diagnosis', () => {
    expect(diagnoseMulesoftFailure('provider_policy')).toContain('rate limits');
  });

  it('provides fallback diagnosis for unknown', () => {
    expect(diagnoseMulesoftFailure('unknown')).toContain('connector logs');
  });

  it('provides fallback diagnosis for null', () => {
    expect(diagnoseMulesoftFailure(null)).toContain('connector logs');
  });
});
