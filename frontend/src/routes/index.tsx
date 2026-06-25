/**
 * Index Route - Dashboard
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import dashboardPage from '@/pages/dashboard.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

export function DashboardScreen() {
  return <UIEngine page={dashboardPage as PageDefinition} />;
}

function DashboardPage() {
  return <DashboardScreen />;
}
