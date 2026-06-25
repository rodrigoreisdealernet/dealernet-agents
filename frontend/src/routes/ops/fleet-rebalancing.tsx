import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import fleetRebalancingPage from '@/pages/fleet-rebalancing.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/ops/fleet-rebalancing')({
  component: FleetRebalancingPage,
});

export function FleetRebalancingScreen() {
  return <UIEngine page={fleetRebalancingPage as PageDefinition} />;
}

function FleetRebalancingPage() {
  return <FleetRebalancingScreen />;
}
