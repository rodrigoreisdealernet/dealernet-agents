/**
 * CRM Customer Profile List Route
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import customerProfileListPage from '@/pages/customer-profile-list.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/crm/customers/')({
  component: CustomerProfileListPage,
});

export function CustomerProfileListScreen() {
  return <UIEngine page={customerProfileListPage as PageDefinition} />;
}

function CustomerProfileListPage() {
  return <CustomerProfileListScreen />;
}
