import type { PageDefinition } from '@/engine/types';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => Record<string, unknown>;

const { uiEngineSpy } = vi.hoisted(() => ({
  uiEngineSpy: vi.fn(),
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', displayName: 'Ops User', role: 'branch_manager' },
    session: { access_token: 'token-123' },
  }),
}));

vi.mock('@/engine', () => ({
  UIEngine: (props: { page: PageDefinition; params: Record<string, string> }) => {
    uiEngineSpy(props);
    return <div data-testid="ui-engine" />;
  },
}));

import { OpsFindingDetailScreen, Route } from '@/routes/ops/findings/$findingId';

describe('ops finding detail route search handoff', () => {
  it('normalizes queue handoff search params and parses numeric delta', () => {
    expect(
      validateSearch({
        source: ' revenue-recognition ',
        severity: ' high ',
        status: '',
        branch: ' north ',
        customer: 42,
        contract: ' C-DEMO-101 ',
        customerName: ' Acme Construction ',
        delta: '1200.5',
      })
    ).toEqual({
      source: 'revenue-recognition',
      severity: 'high',
      status: '%',
      branch: 'north',
      customer: '%',
      contract: 'C-DEMO-101',
      customerName: 'Acme Construction',
      delta: 1200.5,
      returnSeverity: '%',
      returnStatus: '%',
      returnBranch: '%',
      returnCustomer: '%',
      returnSignal: '%',
      returnPriority: '%',
      returnObligation: '%',
    });
  });

  it('seeds queue context in page state for detail fallbacks and return link', () => {
    render(
      <OpsFindingDetailScreen
        findingId="finding-1"
        queueContext={{
          source: 'revenue-recognition',
          severity: 'high',
          status: '%',
          branch: 'north',
          customer: 'acme',
          contract: 'C-DEMO-101',
          customerName: 'Acme Construction',
          delta: 1200,
        }}
      />
    );

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          state: expect.objectContaining({
            queueSource: 'revenue-recognition',
            queueSeverityFilter: 'high',
            queueStatusFilter: '%',
            queueBranchFilter: 'north',
            queueCustomerFilter: 'acme',
            queueContractLabel: 'C-DEMO-101',
            queueCustomerName: 'Acme Construction',
            queueDelta: 1200,
          }),
        }),
      })
    );
  });
});