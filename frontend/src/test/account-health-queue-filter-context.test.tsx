import type { PageDefinition } from '@/engine/types';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Behavioral tests for the account-health-queue → finding detail → back-to-queue
 * filter-context contract (issue #1813).
 *
 * Covered surfaces:
 *  - $findingId.tsx Route.validateSearch: normalises returnSignal / returnPriority search params
 *  - OpsFindingDetailScreen: seeds returnSignal / returnPriority into UIEngine initial page state
 *  - ops-account-health-queue.json: "Review thread" link forwards full filter state (all 4 params)
 *  - ops-finding-detail.json: back-link reconstructs the filtered queue URL from all return* state
 */

const { uiEngineSpy } = vi.hoisted(() => ({
  uiEngineSpy: vi.fn(),
}));

vi.mock('@/engine', () => ({
  UIEngine: (props: { page: PageDefinition }) => {
    uiEngineSpy(props.page);
    return <div data-testid="ui-engine" />;
  },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', displayName: 'Casey', role: 'admin' },
    session: { access_token: 'tok-abc' },
  }),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
      <a href={to as string}>{children}</a>
    ),
  };
});

import { OpsFindingDetailScreen, Route } from '@/routes/ops/findings/$findingId';
import opsAccountHealthQueueJson from '@/pages/ops-account-health-queue.json';
import opsFindingDetailJson from '@/pages/ops-finding-detail.json';

const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => Record<string, unknown>;

// ── helpers ────────────────────────────────────────────────────────────────────

type LinkNode = { to: string; search?: Record<string, string>; children?: string };

function collectLinks(obj: unknown, acc: LinkNode[] = []): LinkNode[] {
  if (!obj || typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) {
    for (const item of obj) collectLinks(item, acc);
  } else {
    const node = obj as Record<string, unknown>;
    if (node.type === 'Link' && node.props) acc.push(node.props as LinkNode);
    for (const val of Object.values(node)) collectLinks(val, acc);
  }
  return acc;
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('account health queue filter context', () => {
  describe('$findingId route validateSearch — returnSignal / returnPriority', () => {
    it('trims and preserves non-empty returnSignal and returnPriority params', () => {
      expect(
        validateSearch({
          returnSignal: ' dormant ',
          returnPriority: ' high ',
          returnStatus: ' pending_approval ',
          returnCustomer: ' acme ',
        })
      ).toEqual(
        expect.objectContaining({
          returnSignal: 'dormant',
          returnPriority: 'high',
          returnStatus: 'pending_approval',
          returnCustomer: 'acme',
        })
      );
    });

    it('falls back to wildcard for empty string returnSignal / returnPriority', () => {
      expect(
        validateSearch({
          returnSignal: '',
          returnPriority: '',
        })
      ).toEqual(
        expect.objectContaining({
          returnSignal: '%',
          returnPriority: '%',
        })
      );
    });

    it('falls back to wildcard when returnSignal / returnPriority are absent', () => {
      expect(validateSearch({})).toEqual(
        expect.objectContaining({
          returnSignal: '%',
          returnPriority: '%',
        })
      );
    });

    it('falls back to wildcard for non-string returnSignal / returnPriority values', () => {
      expect(
        validateSearch({
          returnSignal: 42,
          returnPriority: null,
        })
      ).toEqual(
        expect.objectContaining({
          returnSignal: '%',
          returnPriority: '%',
        })
      );
    });
  });

  describe('OpsFindingDetailScreen UIEngine state seeding', () => {
    it('seeds returnSignal and returnPriority into initial UIEngine page state', () => {
      render(
        <OpsFindingDetailScreen
          findingId="finding-acct-1"
          returnSignal="dormant"
          returnPriority="high"
          returnStatus="pending_approval"
          returnCustomer="acme"
        />
      );

      expect(uiEngineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            returnSignal: 'dormant',
            returnPriority: 'high',
            returnStatus: 'pending_approval',
            returnCustomer: 'acme',
          }),
        })
      );
    });

    it('defaults returnSignal and returnPriority to wildcard when omitted', () => {
      render(<OpsFindingDetailScreen findingId="finding-acct-2" />);

      expect(uiEngineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            returnSignal: '%',
            returnPriority: '%',
          }),
        })
      );
    });
  });

  describe('ops-account-health-queue.json link structure', () => {
    it('"Review thread" link forwards full filter context including signal and priority', () => {
      const links = collectLinks(opsAccountHealthQueueJson);
      const reviewLink = links.find((l) => l.children === 'Review thread →');

      expect(reviewLink).toBeDefined();
      expect(reviewLink?.to).toMatch(/\/ops\/findings\//);
      expect(reviewLink?.search).toEqual({
        source: 'account-health-queue',
        returnSignal: "{{state.signalFilter || '%'}}",
        returnPriority: "{{state.priorityFilter || '%'}}",
        returnStatus: "{{state.statusFilter || '%'}}",
        returnCustomer: "{{state.customerFilter || '%'}}",
      });
    });
  });

  describe('ops-finding-detail.json back-link structure', () => {
    it('back-link points to /ops/account-health-queue and reconstructs all four filter params', () => {
      const links = collectLinks(opsFindingDetailJson);
      const backLink = links.find((l) => l.children?.includes('Back to Account Health Queue'));

      expect(backLink).toBeDefined();
      expect(backLink?.to).toBe('/ops/account-health-queue');
      expect(backLink?.search).toEqual({
        signal: '{{state.returnSignal}}',
        priority: '{{state.returnPriority}}',
        status: '{{state.returnStatus}}',
        customer: '{{state.returnCustomer}}',
      });
    });
  });
});
