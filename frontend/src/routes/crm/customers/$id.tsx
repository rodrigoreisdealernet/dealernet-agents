/**
 * CRM Customer Profile Detail Route
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import customerProfileDetailPage from '@/pages/customer-profile-detail.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/crm/customers/$id')({
  component: CustomerProfileDetailPage,
});

interface CustomerProfileDetailScreenProps {
  id: string;
}

export function CustomerProfileDetailScreen({ id }: CustomerProfileDetailScreenProps) {
  return (
    <UIEngine
      page={customerProfileDetailPage as PageDefinition}
      params={{ id }}
    />
  );
}

function CustomerProfileDetailPage() {
  const { id } = Route.useParams();
  return <CustomerProfileDetailScreen id={id} />;
}
