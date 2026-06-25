import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsAuditTrailPage from '@/pages/ops-audit-trail.json';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/ops/audit/$entityId')({
  validateSearch: (search: Record<string, unknown>) => ({
    event: typeof search.event === 'string' ? search.event : undefined,
  }),
  component: OpsAuditTrailPage,
});

interface OpsAuditTrailScreenProps {
  entityId: string;
  activeEvent?: string;
}

export function OpsAuditTrailScreen({ entityId, activeEvent }: OpsAuditTrailScreenProps) {
  return (
    <UIEngine
      page={opsAuditTrailPage as PageDefinition}
      params={{ entityId, activeEvent: activeEvent ?? '' }}
    />
  );
}

function OpsAuditTrailPage() {
  const { entityId } = Route.useParams();
  const { event: activeEvent } = Route.useSearch();
  return <OpsAuditTrailScreen entityId={entityId} activeEvent={activeEvent} />;
}
