import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from './EmptyState';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe('EmptyState', () => {
  it('renders title and optional hint', () => {
    render(<EmptyState title="No records" hint="Try changing filters" />);
    expect(screen.getByText('No records')).toBeInTheDocument();
    expect(screen.getByText('Try changing filters')).toBeInTheDocument();
  });

  it('renders action link when link props are provided', () => {
    render(<EmptyState title="No tasks" to="/ops" linkLabel="Go to queue" />);
    const link = screen.getByRole('link', { name: 'Go to queue →' });
    expect(link).toHaveAttribute('href', '/ops');
  });
});

