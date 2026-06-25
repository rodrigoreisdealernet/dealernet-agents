/**
 * Route-level tests for the Branch Morning Brief route.
 *
 * Validates that validateSearch normalises missing/empty search params to the
 * correct defaults, and in particular that a missing or empty `status` param
 * falls back to `pending_approval` — not the wildcard `%` used by the generic
 * filter normaliser.  This is the canonical guard that prevents handleStateChange
 * from broadening the default queue to all statuses when the UI engine emits a
 * state change without a populated statusFilter.
 */
import type { PageDefinition } from '@/engine/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

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
  UIEngine: (props: { page: PageDefinition; onStateChange?: (state: Record<string, unknown>) => void }) => {
    uiEngineSpy(props);
    return <div data-testid="ui-engine" />;
  },
}));

import { BranchMorningBriefPage, BranchMorningBriefScreen, Route } from '@/routes/branch/morning-brief';

const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => Record<string, unknown>;

describe('BranchMorningBrief route search validation', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    uiEngineSpy.mockReset();
  });

  it('defaults status to pending_approval when missing from search params', () => {
    expect(validateSearch({})).toMatchObject({ status: 'pending_approval' });
  });

  it('defaults status to pending_approval when search param is empty string', () => {
    expect(validateSearch({ status: '' })).toMatchObject({ status: 'pending_approval' });
  });

  it('defaults status to pending_approval when statusFilter key is absent (handleStateChange path)', () => {
    // When the UI engine emits a state-change without a populated statusFilter the
    // navigate call will produce `status: undefined` in the search object.
    // validateSearch is the re-entry guard — it must normalise that back to
    // pending_approval rather than widening to '%'.
    expect(validateSearch({ status: undefined })).toMatchObject({
      status: 'pending_approval',
    });
  });

  it('preserves an explicit status value', () => {
    expect(validateSearch({ status: 'actioned' })).toMatchObject({ status: 'actioned' });
    expect(validateSearch({ status: 'dismissed' })).toMatchObject({ status: 'dismissed' });
  });

  it('defaults priority and itemType to wildcard when missing', () => {
    expect(validateSearch({})).toMatchObject({ priority: '%', itemType: '%' });
  });

  it('preserves explicit priority and itemType filter values', () => {
    expect(
      validateSearch({ priority: 'critical', itemType: 'contract_exception' }),
    ).toMatchObject({ priority: 'critical', itemType: 'contract_exception' });
  });

  it('seeds initial state from route search props', () => {
    render(<BranchMorningBriefScreen priority="high" itemType="ap_hold" status="actioned" />);

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          state: expect.objectContaining({
            priorityFilter: 'high',
            itemTypeFilter: 'ap_hold',
            statusFilter: 'actioned',
          }),
        }),
      }),
    );
  });

  it('seeds statusFilter to pending_approval when no status prop is given', () => {
    render(<BranchMorningBriefScreen />);

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          state: expect.objectContaining({
            statusFilter: 'pending_approval',
          }),
        }),
      }),
    );
  });

  it('handleStateChange without statusFilter navigates to pending_approval, not %', () => {
    // This is the regression guard: if handleStateChange used readFilterParam
    // instead of readStatusParam the navigate call would receive status:'%' and
    // broaden the queue from pending-review items to all statuses.
    const useSearchSpy = vi.spyOn(Route, 'useSearch').mockReturnValue({
      priority: '%',
      itemType: '%',
      status: 'pending_approval',
    });

    render(<BranchMorningBriefPage />);

    const onStateChange = uiEngineSpy.mock.calls[uiEngineSpy.mock.calls.length - 1]?.[0]?.onStateChange;
    expect(onStateChange).toBeTypeOf('function');

    // Invoke without statusFilter — the exact payload the UI engine emits when
    // a filter that was never touched is omitted from the state-change event.
    onStateChange?.({ priorityFilter: 'critical', itemTypeFilter: 'contract_exception' });

    expect(navigateSpy).toHaveBeenCalledWith({
      search: {
        priority: 'critical',
        itemType: 'contract_exception',
        status: 'pending_approval',
      },
      replace: true,
    });

    useSearchSpy.mockRestore();
  });
});
