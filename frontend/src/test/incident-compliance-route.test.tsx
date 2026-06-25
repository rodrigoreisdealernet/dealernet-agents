import type { PageDefinition } from '@/engine/types';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigateSpy, uiEngineSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  uiEngineSpy: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine', () => ({
  UIEngine: (props: {
    page: PageDefinition;
    onStateChange?: (state: Record<string, unknown>) => void;
  }) => {
    uiEngineSpy(props);
    return <div data-testid="ui-engine" />;
  },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', displayName: 'Casey', role: 'admin' },
    session: { access_token: 'token' },
    isLoading: false,
  }),
}));

import {
  IncidentComplianceQueueScreen,
  Route,
} from '@/routes/ops/incident-compliance-queue';
import { OpsFindingDetailScreen, Route as FindingDetailRoute } from '@/routes/ops/findings/$findingId';

describe('incident compliance queue route contracts', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    uiEngineSpy.mockReset();
  });

  it('syncs obligation and status search params with queue page state and navigation updates', () => {
    const useSearchSpy = vi.spyOn(Route, 'useSearch').mockReturnValue({
      obligation: 'reportable_event_deadline',
      status: 'pending_approval',
    });

    render(<IncidentComplianceQueueScreen obligation="reportable_event_deadline" status="pending_approval" />);

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          state: expect.objectContaining({
            obligationFilter: 'reportable_event_deadline',
            statusFilter: 'pending_approval',
          }),
        }),
      })
    );

    useSearchSpy.mockRestore();
  });

  it('finding detail route preserves returnObligation for incident queue handoff', () => {
    const validateSearch = FindingDetailRoute.options.validateSearch as (search: Record<string, unknown>) => Record<string, unknown>;
    expect(
      validateSearch({
        source: 'incident-compliance-queue',
        returnObligation: ' post_accident_testing ',
        returnStatus: ' pending_approval ',
      })
    ).toEqual(
      expect.objectContaining({
        source: 'incident-compliance-queue',
        returnObligation: 'post_accident_testing',
        returnStatus: 'pending_approval',
      })
    );
  });

  it('finding detail screen seeds returnObligation into UIEngine state', () => {
    render(
      <OpsFindingDetailScreen
        findingId="finding-incident-1"
        queueContext={{ source: 'incident-compliance-queue' }}
        returnObligation="osha_log_follow_up"
        returnStatus="pending_approval"
      />
    );

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          state: expect.objectContaining({
            queueSource: 'incident-compliance-queue',
            returnObligation: 'osha_log_follow_up',
            returnStatus: 'pending_approval',
          }),
        }),
      })
    );
  });
});
