import type { PageDefinition } from '@/engine/types';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Behavioral tests for the fleet-audits queue → finding detail → back-to-queue
 * filter-context contract (issue #1792).
 *
 * Covered surfaces:
 *  - $findingId.tsx Route.validateSearch: normalises return* search params
 *  - OpsFindingDetailScreen: seeds queue context + return* into UIEngine initial page state
 *  - ops-fleet-audits.json: "Open finding" link forwards current filter state and queue context
 *  - ops-finding-detail.json: back-link reconstructs the filtered queue URL from return* state
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
import opsFleetAuditsJson from '@/pages/ops-fleet-audits.json';
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

describe('fleet audits filter context', () => {
  describe('$findingId route validateSearch', () => {
    it('trims and preserves non-empty return* params', () => {
      expect(
        validateSearch({
          returnSeverity: ' high ',
          returnStatus: ' pending_approval ',
          returnBranch: ' north-yard ',
          returnCustomer: ' acme ',
        })
      ).toEqual(
        expect.objectContaining({
          returnSeverity: 'high',
          returnStatus: 'pending_approval',
          returnBranch: 'north-yard',
          returnCustomer: 'acme',
        })
      );
    });

    it('falls back to wildcard for empty string values', () => {
      expect(
        validateSearch({
          returnSeverity: '',
          returnStatus: '',
          returnBranch: '',
          returnCustomer: '',
        })
      ).toEqual(
        expect.objectContaining({
          returnSeverity: '%',
          returnStatus: '%',
          returnBranch: '%',
          returnCustomer: '%',
        })
      );
    });

    it('falls back to wildcard when params are absent', () => {
      expect(validateSearch({})).toEqual(
        expect.objectContaining({
          returnSeverity: '%',
          returnStatus: '%',
          returnBranch: '%',
          returnCustomer: '%',
        })
      );
    });

    it('falls back to wildcard for non-string values', () => {
      expect(
        validateSearch({
          returnSeverity: 42,
          returnStatus: null,
          returnBranch: true,
          returnCustomer: undefined,
        })
      ).toEqual(
        expect.objectContaining({
          returnSeverity: '%',
          returnStatus: '%',
          returnBranch: '%',
          returnCustomer: '%',
        })
      );
    });
  });

  describe('OpsFindingDetailScreen UIEngine state seeding', () => {
    it('seeds queue context props into initial UIEngine page state', () => {
      render(
        <OpsFindingDetailScreen
          findingId="finding-queue"
          queueContext={{
            source: 'fleet-audits',
            severity: 'medium',
            status: 'pending_approval',
            branch: 'north-yard',
            customer: 'acme',
            contract: 'C-DEMO-101',
            customerName: 'Acme Construction',
            delta: 1200,
          }}
        />
      );

      expect(uiEngineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            queueSource: 'fleet-audits',
            queueSeverityFilter: 'medium',
            queueStatusFilter: 'pending_approval',
            queueBranchFilter: 'north-yard',
            queueCustomerFilter: 'acme',
            queueContractLabel: 'C-DEMO-101',
            queueCustomerName: 'Acme Construction',
            queueDelta: 1200,
          }),
        })
      );
    });

    it('seeds return* props into initial UIEngine page state', () => {
      render(
        <OpsFindingDetailScreen
          findingId="finding-abc"
          returnSeverity="high"
          returnStatus="pending_approval"
          returnBranch="north-yard"
          returnCustomer="acme"
        />
      );

      expect(uiEngineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            returnSeverity: 'high',
            returnStatus: 'pending_approval',
            returnBranch: 'north-yard',
            returnCustomer: 'acme',
          }),
        })
      );
    });

    it('defaults return* state to wildcard when props are omitted', () => {
      render(<OpsFindingDetailScreen findingId="finding-xyz" />);

      expect(uiEngineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            returnSeverity: '%',
            returnStatus: '%',
            returnBranch: '%',
            returnCustomer: '%',
          }),
        })
      );
    });
  });

  describe('ops-fleet-audits.json link structure', () => {
    it('"Open finding" link forwards current filter state and queue context as search params', () => {
      const links = collectLinks(opsFleetAuditsJson);
      const openFinding = links.find((l) => l.children === 'Open finding');

      expect(openFinding).toBeDefined();
      expect(openFinding?.to).toMatch(/\/ops\/findings\//);
      expect(openFinding?.search).toEqual({
        source: 'fleet-audits',
        severity: '{{state.severityFilter}}',
        status: '{{state.statusFilter}}',
        branch: '{{state.branchFilter}}',
        customer: '{{state.customerFilter}}',
        contract: "{{finding.contract_label || ''}}",
        customerName: "{{finding.customer_name || ''}}",
        delta: '{{finding.delta || 0}}',
        returnSeverity: '{{state.severityFilter}}',
        returnStatus: '{{state.statusFilter}}',
        returnBranch: '{{state.branchFilter}}',
        returnCustomer: '{{state.customerFilter}}',
      });
    });
  });

  describe('ops-finding-detail.json back-link structure', () => {
    it('back-link points to /ops/fleet-audits and reconstructs filter params from return* state', () => {
      const links = collectLinks(opsFindingDetailJson);
      const backLink = links.find((l) => l.children?.includes('Back to Fleet Audits'));

      expect(backLink).toBeDefined();
      expect(backLink?.to).toBe('/ops/fleet-audits');
      expect(backLink?.search).toEqual({
        severity: '{{state.returnSeverity}}',
        status: '{{state.returnStatus}}',
        branch: '{{state.returnBranch}}',
        customer: '{{state.returnCustomer}}',
      });
    });
  });
});
