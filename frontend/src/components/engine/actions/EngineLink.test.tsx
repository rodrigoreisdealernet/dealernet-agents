import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EngineLink } from './EngineLink';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe('EngineLink', () => {
  it('keeps inline appearance by default', () => {
    render(<EngineLink to="/items">Open</EngineLink>);
    const link = screen.getByRole('link', { name: 'Open' });
    expect(link).toHaveClass('hover:underline');
  });

  it('renders action appearance with trailing arrow', () => {
    render(<EngineLink to="/items" appearance="action">Open</EngineLink>);
    const link = screen.getByRole('link', { name: 'Open' });
    expect(link).toHaveTextContent('Open →');
    expect(link).toHaveClass('text-sm');
  });

  it('renders button appearance using button styles', () => {
    render(<EngineLink to="/items" appearance="button">Open</EngineLink>);
    const link = screen.getByRole('link', { name: 'Open' });
    expect(link).toHaveClass('h-10');
  });
});
