import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatCard } from './StatCard';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe('StatCard', () => {
  it('renders label, value, hint, icon, and delta', () => {
    const { container } = render(
      <StatCard
        label="Open Orders"
        value="24"
        hint="Since yesterday"
        icon="AlertCircle"
        tone="info"
        delta={{ direction: 'up', label: '8%' }}
      />
    );

    expect(screen.getByText('Open Orders')).toBeInTheDocument();
    expect(screen.getByText('24')).toBeInTheDocument();
    expect(screen.getByText('Since yesterday')).toBeInTheDocument();
    expect(screen.getByText('8%')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders direction markers for delta states', () => {
    const { rerender } = render(
      <StatCard label="A" value="1" delta={{ direction: 'up', label: 'up' }} />
    );
    expect(screen.getByText('▲')).toBeInTheDocument();

    rerender(<StatCard label="A" value="1" delta={{ direction: 'down', label: 'down' }} />);
    expect(screen.getByText('▼')).toBeInTheDocument();

    rerender(<StatCard label="A" value="1" delta={{ direction: 'flat', label: 'flat' }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('adds interactive styles and footer link label when navigable', () => {
    render(<StatCard label="Revenue" value="$1000" to="/ops" linkLabel="View details" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/ops');
    expect(screen.getByText('View details →')).toBeInTheDocument();
  });
});
