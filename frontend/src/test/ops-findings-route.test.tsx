import type { PageDefinition } from '@/engine/types';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => Record<string, unknown>;

const { uiEngineSpy } = vi.hoisted(() => ({
  uiEngineSpy: vi.fn(),
}));

vi.mock('@/engine', () => ({
  UIEngine: (props: { page: PageDefinition }) => {
    uiEngineSpy(props.page);
    return <div data-testid="ui-engine" />;
  },
}));

import { OpsFindingsQueueScreen, Route } from '@/routes/ops/findings/index';

describe('ops findings route search validation', () => {
  it('normalizes workflow search param and falls back to wildcard', () => {
    expect(validateSearch({ workflow: ' quote-to-order-copilot ' })).toEqual({
      workflow: 'quote-to-order-copilot',
    });
    expect(validateSearch({ workflow: '' })).toEqual({ workflow: '%' });
    expect(validateSearch({})).toEqual({ workflow: '%' });
  });

  it('seeds initial workflow filter state from route workflow value', () => {
    render(<OpsFindingsQueueScreen workflowFilter="damage-returns-charge-assistant" />);

    expect(uiEngineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          workflowFilter: 'damage-returns-charge-assistant',
        }),
      })
    );
  });
});