/**
 * Entity Detail Route
 */

import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { UIEngine } from '@/engine';
import entityDetailPage from '@/pages/entity-detail.json';
import maintenanceWorkOrderDetailPage from '@/pages/maintenance-work-order-detail.json';
import type { PageDefinition } from '@/engine/types';
import { getEntityLabels } from '@/lib/entityLabels';
import { AssetUpdatePanel } from '@/components/assets/AssetUpdatePanel';
import { useAuth } from '@/auth/AuthContext';

export const Route = createFileRoute('/entities/$entityType/$id')({
  component: EntityDetailPage,
});

interface EntityDetailScreenProps {
  entityType: string;
  id: string;
}

type PortalDispatchContext = {
  source: string;
  assetName: string | null;
  jobSiteId: string | null;
  startDate: string | null;
  endDate: string | null;
};

function readPortalDispatchContext(): PortalDispatchContext | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const source = params.get('source');
  if (source !== 'portal_catalog') return null;
  const read = (key: string) => {
    const value = params.get(key);
    return value && value.trim().length > 0 ? value.trim() : null;
  };
  return {
    source,
    assetName: read('assetName'),
    jobSiteId: read('jobSiteId'),
    startDate: read('startDate'),
    endDate: read('endDate'),
  };
}

export function EntityDetailScreen({ entityType, id }: EntityDetailScreenProps) {
  const labels = getEntityLabels(entityType);
  const { session } = useAuth();
  const portalDispatchContext = useMemo(() => readPortalDispatchContext(), []);

  const maintenancePage = useMemo<PageDefinition>(() => {
    const base = maintenanceWorkOrderDetailPage as PageDefinition;
    return {
      ...base,
      state: {
        ...(base.state || {}),
        accessToken: session?.access_token || '',
      },
    };
  }, [session?.access_token]);

  if (entityType === 'maintenance_record') {
    return <UIEngine page={maintenancePage} params={{ id }} />;
  }

  return (
    <div className="space-y-6">
      {entityType === 'requisition' && portalDispatchContext && (
        <Alert data-testid="portal-dispatch-context">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Portal requisition recorded</AlertTitle>
          <AlertDescription>
            Request for <strong>{portalDispatchContext.assetName ?? 'selected asset'}</strong>
            {' '}at job site <strong>{portalDispatchContext.jobSiteId ?? 'provided scope'}</strong>
            {' '}from <strong>{portalDispatchContext.startDate ?? 'requested start'}</strong>
            {' '}to <strong>{portalDispatchContext.endDate ?? 'requested end'}</strong>.
          </AlertDescription>
        </Alert>
      )}
      <UIEngine
        page={entityDetailPage as PageDefinition}
        params={{
          entityType,
          id,
          entityLabelSingular: labels.singular,
          entityLabelPlural: labels.plural,
          entityLabelSingularLower: labels.singularLower,
          entityLabelPluralLower: labels.pluralLower,
        }}
      />
      {entityType === 'asset' ? <AssetUpdatePanel assetId={id} /> : null}
    </div>
  );
}

function EntityDetailPage() {
  const { entityType, id } = Route.useParams();
  return <EntityDetailScreen entityType={entityType} id={id} />;
}
