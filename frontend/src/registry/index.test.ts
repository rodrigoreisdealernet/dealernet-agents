import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './index';

describe('default registry', () => {
  it('registers new engine UI components', () => {
    const registry = createDefaultRegistry();
    expect(registry.has('StatCard')).toBe(true);
    expect(registry.has('EmptyState')).toBe(true);
  });
});

