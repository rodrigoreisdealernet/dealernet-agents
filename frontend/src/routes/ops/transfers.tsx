import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import transferManagementPage from '@/pages/transfer-management.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/ops/transfers')({
  component: TransferManagementPage,
});

export function TransferManagementScreen() {
  return <UIEngine page={transferManagementPage as PageDefinition} />;
}

function TransferManagementPage() {
  return <TransferManagementScreen />;
}
