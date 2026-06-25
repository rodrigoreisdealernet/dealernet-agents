/**
 * Regression tests for the production devtools exclusion guard (PR #849).
 *
 * Three acceptance criteria are covered:
 * 1. Dependency classification  — @tanstack/react-query-devtools stays in
 *    devDependencies so it is excluded from production bundles.
 * 2. Source-level guard         — main.tsx gates <ReactQueryDevtools> behind
 *    import.meta.env.DEV with no unconditional render path.
 *    NOTE: sections 2 and 3 are complementary, not redundant. Section 3's
 *    render tests exercise the guard pattern in isolation and would still pass
 *    if the guard were removed from main.tsx; section 2 catches that regression.
 * 3. Runtime render behaviour   — the guard expression does not produce devtools
 *    UI when DEV is false, and does produce it when DEV is true.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import pkg from '../../package.json';

// ---------------------------------------------------------------------------
// Mock @tanstack/react-query-devtools so we can detect if it is rendered.
// The mock must be declared before any imports that use it (vi.mock is hoisted).
// ---------------------------------------------------------------------------
vi.mock('@tanstack/react-query-devtools', () => ({
  ReactQueryDevtools: () => <div data-testid="rq-devtools-sentinel" />,
}));

import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

// ---------------------------------------------------------------------------
// 1. Dependency classification
// ---------------------------------------------------------------------------
describe('devtools dependency classification', () => {
  it('keeps @tanstack/react-query-devtools in devDependencies, not dependencies', () => {
    expect(pkg.dependencies).not.toHaveProperty('@tanstack/react-query-devtools');
    expect(pkg.devDependencies).toHaveProperty('@tanstack/react-query-devtools');
  });
});

// ---------------------------------------------------------------------------
// 2. Source-level guard assertion (main.tsx)
// ---------------------------------------------------------------------------
describe('main.tsx DEV guard — source', () => {
  const mainSrc = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');

  it('guards ReactQueryDevtools behind import.meta.env.DEV', () => {
    expect(mainSrc).toMatch(/import\.meta\.env\.DEV\s*&&\s*<ReactQueryDevtools/);
  });

  it('has no unconditional ReactQueryDevtools JSX element outside the guard', () => {
    // Ignore import statements; every remaining occurrence of <ReactQueryDevtools
    // must sit on the same line as the import.meta.env.DEV guard.
    const nonImportLines = mainSrc
      .split('\n')
      .filter(line => !line.trimStart().startsWith('import'));

    const unguardedLines = nonImportLines.filter(
      line =>
        /<ReactQueryDevtools/.test(line) && !/import\.meta\.env\.DEV/.test(line),
    );

    expect(unguardedLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Runtime render behaviour
// ---------------------------------------------------------------------------
describe('devtools guard — runtime render behaviour', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not render ReactQueryDevtools when DEV is false (production)', () => {
    vi.stubEnv('DEV', false);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId('rq-devtools-sentinel')).not.toBeInTheDocument();
  });

  it('renders ReactQueryDevtools when DEV is true (development)', () => {
    vi.stubEnv('DEV', true);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('rq-devtools-sentinel')).toBeInTheDocument();
  });
});
