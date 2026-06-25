import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Grid } from './Grid';

describe('Grid', () => {
  it('renders numeric columns and gap as inline grid styles', () => {
    const { container } = render(
      <Grid columns={2} gap={4}>
        <div>Card</div>
      </Grid>
    );

    const grid = container.firstElementChild as HTMLDivElement;

    expect(grid.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    expect(grid.style.gap).toBe('1rem');
  });

  it('keeps string columns and gap styling unchanged', () => {
    const { container } = render(
      <Grid columns="repeat(auto-fit, minmax(16rem, 1fr))" gap="2rem">
        <div>Card</div>
      </Grid>
    );

    const grid = container.firstElementChild as HTMLDivElement;

    expect(grid.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(16rem, 1fr))');
    expect(grid.style.gap).toBe('2rem');
  });
});
