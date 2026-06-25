import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EngineBadge, mapStatusToTone } from './EngineBadge';

describe('EngineBadge', () => {
  it('maps known statuses to semantic tone classes', () => {
    render(<EngineBadge status="available">Available</EngineBadge>);
    const badge = screen.getByText('Available');
    expect(badge).toHaveClass('bg-green-50');
    expect(mapStatusToTone('on_rent')).toBe('info');
    expect(mapStatusToTone('pending')).toBe('warning');
    expect(mapStatusToTone('failed')).toBe('danger');
  });

  it.each([
    ['requested',         'warning'],
    ['awarded',           'info'],
    ['dispatched',        'info'],
    ['scheduled',         'info'],
    ['in_progress',       'info'],
    ['triage',            'warning'],
    ['awaiting_parts',    'warning'],
    ['on_rent',           'info'],
    ['return_in_transit', 'warning'],
    ['returned',          'success'],
  ])('maps re-rent lifecycle status %s to tone %s', (status, expected) => {
    expect(mapStatusToTone(status)).toBe(expected);
  });

  it('falls back to neutral tone for unknown statuses', () => {
    render(<EngineBadge status="custom_state">Unknown</EngineBadge>);
    expect(screen.getByText('Unknown')).toHaveClass('bg-slate-100');
    expect(screen.getByText('Unknown')).toHaveClass('text-slate-800');
    expect(mapStatusToTone('custom_state')).toBe('neutral');
  });

  it('keeps variant-based rendering when status is not set', () => {
    render(<EngineBadge variant="destructive">Failure</EngineBadge>);
    expect(screen.getByText('Failure')).toHaveClass('bg-destructive');
  });
});
