import { describe, expect, it } from 'vitest';
import { buttonVariants } from './button';

describe('buttonVariants', () => {
  it('uses the branded primary glow by default', () => {
    const classes = buttonVariants();
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('shadow-[var(--button-primary-shadow)]');
    expect(classes).toContain('hover:shadow-[var(--button-primary-glow)]');
  });

  it('supports pill sizing for CTA usage', () => {
    const classes = buttonVariants({ size: 'pill' });
    expect(classes).toContain('rounded-full');
  });
});
