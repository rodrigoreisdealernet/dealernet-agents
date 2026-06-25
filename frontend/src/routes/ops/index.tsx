import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsFactoryDashboardPage from '@/pages/ops-factory-dashboard.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/ops/')({
  component: OpsFactoryDashboardPage,
});

export function OpsFactoryDashboardScreen() {
  return <UIEngine page={opsFactoryDashboardPage as PageDefinition} />;
}

function OpsFactoryDashboardPage() {
  return <OpsFactoryDashboardScreen />;
}
