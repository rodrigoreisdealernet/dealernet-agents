/**
 * Org Hierarchy Route — company → region → branch tree viewer
 */

import { useMemo, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UIEngine } from '@/engine';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import { useDataSources } from '@/engine/useDataSources';
import orgHierarchyPage from '@/pages/org-hierarchy.json';
import type { DataSourceDefinition, PageDefinition } from '@/engine/types';
import {
  buildConfigChangeImpactPreview,
  CONFIG_IMPACT_TAGS,
  type ConfigChangeDomain,
  type ConfigImpactItem,
  type PendingConfigChangeDraft,
} from '@/lib/configChangeImpactAssistant';

export const Route = createFileRoute('/enterprise/org-hierarchy')({
  component: OrgHierarchyPage,
});

const impactDataSources: Record<string, DataSourceDefinition> = {
  ...(orgHierarchyPage as PageDefinition).dataSources,
  profiles: {
    type: 'supabase',
    table: 'profiles',
    select: 'id, display_name, role, tenant',
    order: [{ column: 'display_name', ascending: true }],
  },
  ratePlans: {
    type: 'supabase',
    table: 'inventory_rate_plans',
    select: 'id, name, effective_from, effective_to, branch_id, customer_id, billing_account_id, category_id, is_active, daily_rate, weekly_rate, monthly_rate',
    order: [{ column: 'effective_from', ascending: false }],
  },
  contracts: {
    type: 'supabase',
    table: 'v_rental_contract_current',
    select: 'entity_id, data',
    order: [{ column: 'created_at', ascending: false }],
    limit: 200,
  },
};

const CHANGE_TYPE_OPTIONS: Array<{ value: ConfigChangeDomain; label: string }> = [
  { value: 'access_scope', label: 'Access scope change' },
  { value: 'hierarchy_visibility', label: 'Hierarchy visibility change' },
  { value: 'billing_pricing', label: 'Billing or pricing change' },
  { value: 'reporting_audience', label: 'Reporting audience change' },
];

function renderGroupItem(item: ConfigImpactItem) {
  return (
    <li key={item.id} className="rounded-md border p-3 text-sm">
      <p className="font-medium">{item.label}</p>
      <p className="mt-1 text-muted-foreground">{item.detail}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{item.source}</Badge>
        {item.drillDownHref ? (
          <Link to={item.drillDownHref} className="text-primary underline-offset-4 hover:underline">
            Open record
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function groupCard(title: string, subtitle: string, items: ConfigImpactItem[]) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <Badge variant="outline">{items.length}</Badge>
        </div>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length > 0 ? (
          <ul className="space-y-2">{items.map((item) => renderGroupItem(item))}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">No direct impacts found for this group in the current source records.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ConfigurationChangeImpactAssistant() {
  const context = useMemo(() => createExpressionContext(), []);
  const { data } = useDataSources(impactDataSources, context);
  const { profiles, hierarchy, scopeConfig, ratePlans, contracts } = data;

  const [draft, setDraft] = useState<PendingConfigChangeDraft>({
    domain: 'access_scope',
    targetRole: 'branch_manager',
    targetId: '',
  });
  // Keep a stable canonical preview per pending draft. Edits stay local until the
  // admin explicitly refreshes the preview with "Preview impact".
  const [activeDraft, setActiveDraft] = useState<PendingConfigChangeDraft>(draft);

  const preview = useMemo(() => buildConfigChangeImpactPreview({
    draft: activeDraft,
    profiles,
    hierarchy,
    scopeConfig,
    ratePlans,
    contracts,
  }), [activeDraft, contracts, hierarchy, profiles, ratePlans, scopeConfig]);

  return (
    <section className="mx-auto mt-6 max-w-7xl px-4 sm:px-6 lg:px-8" data-testid="config-impact-assistant">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Assist only</Badge>
            <Badge variant="outline">Human approval required</Badge>
            {CONFIG_IMPACT_TAGS.map((tag) => (
              <Badge key={tag} variant="outline">{tag}</Badge>
            ))}
          </div>
          <CardTitle className="mt-2">Configuration change impact assistant</CardTitle>
          <CardDescription>
            Draft an admin access, hierarchy, billing/pricing, or reporting-audience change to preview likely blast radius before applying anything.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              Change type
              <select
                aria-label="Change type"
                className="rounded-md border px-3 py-2"
                value={draft.domain}
                onChange={(event) => setDraft((current) => ({ ...current, domain: event.target.value as ConfigChangeDomain }))}
              >
                {CHANGE_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Target scope/record ID (optional)
              <input
                aria-label="Target scope or record ID"
                className="rounded-md border px-3 py-2"
                value={draft.targetId || ''}
                onChange={(event) => setDraft((current) => ({ ...current, targetId: event.target.value }))}
                placeholder="branch/region/billing/plan id"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Target role (access changes)
              <select
                aria-label="Target role"
                className="rounded-md border px-3 py-2"
                value={draft.targetRole || ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((current) => ({
                    ...current,
                    targetRole: value ? value as PendingConfigChangeDraft['targetRole'] : undefined,
                  }));
                }}
              >
                <option value="">No role selected</option>
                <option value="admin">admin</option>
                <option value="branch_manager">branch_manager</option>
                <option value="field_operator">field_operator</option>
                <option value="read_only">read_only</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={() => setActiveDraft({ ...draft })}>
              Preview impact
            </Button>
            <p className="text-sm text-muted-foreground">Canonical preview: <span className="font-mono">{preview.previewKey}</span></p>
          </div>

          {preview.highRiskFlags.length > 0 ? (
            <Alert variant="destructive">
              <AlertTitle>High-risk conflicts need human review</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {preview.highRiskFlags.map((flag) => <li key={flag}>{flag}</li>)}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {preview.uncertainties.length > 0 ? (
            <Alert>
              <AlertTitle>Uncertainty surfaced explicitly</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {preview.uncertainties.map((note) => <li key={note}>{note}</li>)}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            {groupCard('Affected users', 'Role-bound users likely to see access, visibility, or audience impact.', preview.groups.users)}
            {groupCard('Branches and regions', 'Hierarchy/config records potentially touched by the draft change.', preview.groups.scopes)}
            {groupCard('Contracts and pricing surfaces', 'Active pricing plans and current contract context that could be impacted.', preview.groups.pricing)}
            {groupCard('Reporting audiences', 'Saved dashboard audiences and governed reporting metrics in scope.', preview.groups.reporting)}
          </div>

          <p className="text-sm text-muted-foreground">
            This assistant never applies access, hierarchy, billing, pricing, or reporting changes automatically; an administrator still approves and executes any final update.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

export function OrgHierarchyPage() {
  return (
    <>
      <UIEngine page={orgHierarchyPage as PageDefinition} />
      <ConfigurationChangeImpactAssistant />
    </>
  );
}
