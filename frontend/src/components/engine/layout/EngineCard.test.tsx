import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EngineCard } from './EngineCard';

describe('EngineCard', () => {
  it('uses base card title styling for section-sized headings', () => {
    render(<EngineCard title="Summary">Body</EngineCard>);
    expect(screen.getByText('Summary')).toHaveClass('text-base');
  });

  it('applies interactive hover classes when enabled', () => {
    const { container } = render(<EngineCard interactive>Body</EngineCard>);
    expect(container.firstElementChild).toHaveClass('hover:border-primary/30');
  });

  it('uses compact padding when requested', () => {
    const { container } = render(<EngineCard padding="compact">Body</EngineCard>);
    expect(container.querySelector('.p-4')).toBeTruthy();
  });
});

