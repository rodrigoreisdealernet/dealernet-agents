/**
 * Entity List Route
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import entityListPage from '@/pages/entity-list.json';
import type { PageDefinition } from '@/engine/types';
import { getEntityLabels } from '@/lib/entityLabels';

export const Route = createFileRoute('/entities/$entityType/')({
  validateSearch: (search: Record<string, unknown>) => ({
    contractId: typeof search.contractId === 'string' && search.contractId.trim() !== ''
      ? search.contractId
      : undefined,
  }),
  component: EntityListPage,
});

interface EntityListScreenProps {
  entityType: string;
  contractId?: string;
}

export function EntityListScreen({ entityType, contractId }: EntityListScreenProps) {
  const labels = getEntityLabels(entityType);

  return (
    <UIEngine
      page={entityListPage as PageDefinition}
      params={{
        entityType,
        entityLabelSingular: labels.singular,
        entityLabelPlural: labels.plural,
        entityLabelSingularLower: labels.singularLower,
        entityLabelPluralLower: labels.pluralLower,
        ...(contractId ? { contractId } : {}),
      }}
    />
  );
}

function EntityListPage() {
  const { entityType } = Route.useParams();
  const { contractId } = Route.useSearch();
  return <EntityListScreen entityType={entityType} contractId={contractId} />;
}
