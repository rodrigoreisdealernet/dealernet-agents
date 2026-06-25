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

import {
  RevenueRecognitionPage,
  Route as RevenueRecognitionRoute,
} from '@/routes/ops/revenue-recognition';
import { CollectionsQueuePage, Route as CollectionsRoute } from '@/routes/ops/collections';
import { BillingUpdateQueuePage, Route as BillingUpdatesRoute } from '@/routes/ops/billing-updates';

describe('ops route search-param sync', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    uiEngineSpy.mockReset();
  });

  it('syncs revenue-recognition search params with page state and navigation updates', () => {
    const useSearchSpy = vi.spyOn(RevenueRecognitionRoute, 'useSearch').mockReturnValue({
      severity: 'high',
      status: 'pending_approval',
      branch: 'north-yard',
      customer: 'acme',
    });

    render(<RevenueRecognitionPage />);

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          state: expect.objectContaining({
            severityFilter: 'high',
            statusFilter: 'pending_approval',
            branchFilter: 'north-yard',
            customerFilter: 'acme',
          }),
        }),
      })
    );

    const onStateChange = uiEngineSpy.mock.calls[uiEngineSpy.mock.calls.length - 1]?.[0]?.onStateChange;
    expect(onStateChange).toEqual(expect.any(Function));

    onStateChange?.({
      severityFilter: ' low ',
      statusFilter: '',
      branchFilter: 42,
      customerFilter: ' acme west ',
    });

    expect(navigateSpy).toHaveBeenCalledWith({
      search: {
        severity: 'low',
        status: '%',
        branch: '%',
        customer: 'acme west',
      },
      replace: true,
    });

    useSearchSpy.mockRestore();
  });

  it('syncs collections search params with page state and navigation updates', () => {
    const useSearchSpy = vi.spyOn(CollectionsRoute, 'useSearch').mockReturnValue({
      severity: 'critical',
      status: 'pending_approval',
    });

    render(<CollectionsQueuePage />);

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          state: expect.objectContaining({
            severityFilter: 'critical',
            statusFilter: 'pending_approval',
          }),
        }),
      })
    );

    const onStateChange = uiEngineSpy.mock.calls[uiEngineSpy.mock.calls.length - 1]?.[0]?.onStateChange;
    expect(onStateChange).toEqual(expect.any(Function));

    onStateChange?.({
      severityFilter: ' warning ',
      statusFilter: null,
    });

    expect(navigateSpy).toHaveBeenCalledWith({
      search: {
        severity: 'warning',
        status: '%',
      },
      replace: true,
    });

    useSearchSpy.mockRestore();
  });

  it('syncs billing-updates search params with page state and preserves review context on state updates', () => {
    const validateSearch = BillingUpdatesRoute.options
      .validateSearch as (search: Record<string, unknown>) => Record<string, unknown>;
    expect(
      validateSearch({
        requestType: ' billing_contact ',
        status: ' pending ',
        requestId: ' req-123 ',
        reviewAction: ' review ',
      }),
    ).toEqual({
      requestType: 'billing_contact',
      status: 'pending',
      requestId: 'req-123',
      reviewAction: 'review',
    });

    const useSearchSpy = vi.spyOn(BillingUpdatesRoute, 'useSearch').mockReturnValue({
      requestType: 'billing_contact',
      status: 'pending',
      requestId: 'req-123',
      reviewAction: 'review',
    });

    render(<BillingUpdateQueuePage />);

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          state: expect.objectContaining({
            requestTypeFilter: 'billing_contact',
            statusFilter: 'pending',
            selectedRequestId: 'req-123',
            selectedReviewAction: 'review',
          }),
        }),
      }),
    );

    const onStateChange = uiEngineSpy.mock.calls[uiEngineSpy.mock.calls.length - 1]?.[0]?.onStateChange;
    expect(onStateChange).toEqual(expect.any(Function));

    onStateChange?.({
      statusFilter: 'approved',
    });

    expect(navigateSpy).toHaveBeenCalledWith({
      search: {
        requestType: 'billing_contact',
        status: 'approved',
        requestId: 'req-123',
        reviewAction: 'review',
      },
      replace: true,
    });

    useSearchSpy.mockRestore();
  });
});
