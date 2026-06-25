import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsFindingDetailPage from '@/pages/ops-finding-detail.json';
import { useAuth } from '@/auth/AuthContext';
import type { PageDefinition } from '@/engine/types';

function readSearchParam(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function readFilterParam(value: unknown): string {
  const normalized = readSearchParam(value);
  return normalized.length > 0 ? normalized : '%';
}

function readNumberParam(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const Route = createFileRoute('/ops/findings/$findingId')({
  validateSearch: (search: Record<string, unknown>) => ({
    source: readSearchParam(search.source),
    severity: readFilterParam(search.severity),
    status: readFilterParam(search.status),
    branch: readFilterParam(search.branch),
    customer: readFilterParam(search.customer),
    contract: readSearchParam(search.contract),
    customerName: readSearchParam(search.customerName),
    delta: readNumberParam(search.delta),
    returnSeverity: readFilterParam(search.returnSeverity),
    returnStatus: readFilterParam(search.returnStatus),
    returnBranch: readFilterParam(search.returnBranch),
    returnCustomer: readFilterParam(search.returnCustomer),
    returnSignal: readFilterParam(search.returnSignal),
    returnPriority: readFilterParam(search.returnPriority),
    returnObligation: readFilterParam(search.returnObligation),
  }),
  component: OpsFindingDetailPage,
});

interface OpsFindingDetailScreenProps {
  findingId: string;
  queueContext?: {
    source?: string;
    severity?: string;
    status?: string;
    branch?: string;
    customer?: string;
    contract?: string;
    customerName?: string;
    delta?: number | null;
  };
  returnSeverity?: string;
  returnStatus?: string;
  returnBranch?: string;
  returnCustomer?: string;
  returnSignal?: string;
  returnPriority?: string;
  returnObligation?: string;
}

export function OpsFindingDetailScreen({
  findingId,
  queueContext,
  returnSeverity = '%',
  returnStatus = '%',
  returnBranch = '%',
  returnCustomer = '%',
  returnSignal = '%',
  returnPriority = '%',
  returnObligation = '%',
}: OpsFindingDetailScreenProps) {
  const { profile, session, isLoading: authLoading } = useAuth();

  const page = useMemo<PageDefinition>(() => {
    const basePage = opsFindingDetailPage as PageDefinition;
    return {
      ...basePage,
      state: {
        ...(basePage.state || {}),
        accessToken: session?.access_token || '',
        approverId: profile?.id || '',
        approverName: profile?.displayName || '',
        queueSource: queueContext?.source || '',
        queueSeverityFilter: queueContext?.severity || '%',
        queueStatusFilter: queueContext?.status || '%',
        queueBranchFilter: queueContext?.branch || '%',
        queueCustomerFilter: queueContext?.customer || '%',
        queueContractLabel: queueContext?.contract || '',
        queueCustomerName: queueContext?.customerName || '',
        queueDelta: queueContext?.delta ?? null,
        returnSeverity,
        returnStatus,
        returnBranch,
        returnCustomer,
        returnSignal,
        returnPriority,
        returnObligation,
      },
    };
  }, [
    profile?.displayName,
    profile?.id,
    queueContext?.branch,
    queueContext?.contract,
    queueContext?.customer,
    queueContext?.customerName,
    queueContext?.delta,
    queueContext?.severity,
    queueContext?.source,
    queueContext?.status,
    session?.access_token,
    returnSeverity,
    returnStatus,
    returnBranch,
    returnCustomer,
    returnSignal,
    returnPriority,
    returnObligation,
  ]);

  const engineKey = [
    findingId,
    profile?.role || '',
    profile?.id || '',
    profile?.displayName || '',
    session ? 'session' : '',
  ].join(':');

  // Defer rendering until auth has settled so UIEngine mounts exactly once
  // with the correct canOperate / accessToken context.
  if (authLoading) {
    return null;
  }

  return <UIEngine key={engineKey} page={page} params={{ findingId }} />;
}

function OpsFindingDetailPage() {
  const { findingId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <OpsFindingDetailScreen
      findingId={findingId}
      queueContext={{
        source: search.source,
        severity: search.severity,
        status: search.status,
        branch: search.branch,
        customer: search.customer,
        contract: search.contract,
        customerName: search.customerName,
        delta: search.delta,
      }}
      returnSeverity={search.returnSeverity}
      returnStatus={search.returnStatus}
      returnBranch={search.returnBranch}
      returnCustomer={search.returnCustomer}
      returnSignal={search.returnSignal}
      returnPriority={search.returnPriority}
      returnObligation={search.returnObligation}
    />
  );
}
