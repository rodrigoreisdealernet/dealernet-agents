import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'path';

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    // Allow the containerized dev server to be reached via its k8s
    // service/LoadBalancer host (Vite 5 blocks unknown Hosts by default → 403).
    // Dev-only: this profile serves placeholder data behind a nonprod LB.
    allowedHosts: true,
    // Local dev: forward Operations Factory API calls (relative /api/ops/*) to the
    // ops-api container so the Findings/Approvals + accounting surfaces work end-to-end.
    proxy: {
      '/api/ops': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
    // Playwright E2E specs live in e2e/ — keep them out of the vitest (unit) run.
    exclude: ['node_modules', 'dist', 'e2e/**'],
    // Coverage is opt-in (`--coverage`) and NON-gating — no thresholds here, so a low
    // number never fails CI. The CI job emits `coverage-summary.json` for the
    // ci-history `coverage` trend (see .github/scripts/coverage-compute.mjs).
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts', 'src/routeTree.gen.ts'],
    },
  },
});
