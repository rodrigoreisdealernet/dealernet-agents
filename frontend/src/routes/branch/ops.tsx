/**
 * Branch Operations Dashboard Route
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import branchOpsDashboardPage from '@/pages/branch-ops-dashboard.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/branch/ops')({
  component: BranchOpsDashboardPage,
});

export function BranchOpsDashboardScreen() {
  return <UIEngine page={branchOpsDashboardPage as PageDefinition} />;
}

function BranchOpsDashboardPage() {
  return <BranchOpsDashboardScreen />;
}
