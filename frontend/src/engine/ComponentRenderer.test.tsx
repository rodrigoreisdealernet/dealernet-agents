import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentRenderer } from './ComponentRenderer';
import { createExpressionContext } from './ExpressionEvaluator';
import type { EngineComponentProps } from '@/engine/types';
import { createRegistry, setGlobalRegistry } from '@/registry/createRegistry';

function TestText(props: EngineComponentProps) {
  return <div>{String(props.value ?? '')}</div>;
}

describe('ComponentRenderer', () => {
  beforeEach(() => {
    setGlobalRegistry(createRegistry({ TestText }));
  });

  it('renders conditionally when the if expression is truthy and suppresses when falsey', () => {
    const context = createExpressionContext({ state: { show: false } });

    const { rerender } = render(
      <ComponentRenderer
        definition={{
          type: 'TestText',
          if: '{{state.show}}',
          props: { value: 'Visible content' },
        }}
        context={context}
      />
    );

    expect(screen.queryByText('Visible content')).not.toBeInTheDocument();

    rerender(
      <ComponentRenderer
        definition={{
          type: 'TestText',
          if: '{{state.show}}',
          props: { value: 'Visible content' },
        }}
        context={createExpressionContext({ state: { show: true } })}
      />
    );

    expect(screen.getByText('Visible content')).toBeInTheDocument();
  });

  it('renders each items with item/index expressions and custom key expression', () => {
    render(
      <ComponentRenderer
        definition={{
          type: 'TestText',
          each: '{{data.rows}}',
          as: 'entry',
          indexAs: 'idx',
          key: '{{entry.id}}',
          props: { value: '{{entry.name}} #{{idx}}' },
        }}
        context={createExpressionContext({
          data: {
            rows: [
              { id: 'row-1', name: 'North Yard' },
              { id: 'row-2', name: 'South Yard' },
            ],
          },
        })}
      />
    );

    expect(screen.getByText('North Yard #0')).toBeInTheDocument();
    expect(screen.getByText('South Yard #1')).toBeInTheDocument();
  });

  it('shows fallback UI when a component is missing from the registry', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    render(
      <ComponentRenderer
        definition={{
          type: 'UnknownWidget',
        }}
        context={createExpressionContext()}
      />
    );

    expect(screen.getByText('Unknown component: UnknownWidget')).toBeInTheDocument();

    warnSpy.mockRestore();
  });
});
