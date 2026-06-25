/**
 * Ops – Billing & Payment Update Request Queue
 *
 * Internal approval queue for customer-submitted billing-contact and
 * payment-detail update requests.  All requested changes are shown here with
 * account context; no change takes effect until a reviewer approves it.
 *
 * Assist-only: this surface surfaces pending requests and missing information
 * for disposition.  The actual approve/reject action is performed via the
 * BillingUpdateApprovalWorkflow signal pathway or the
 * ops_record_billing_update_decision RPC.
 */
import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsBillingUpdateQueuePage from '@/pages/ops-billing-update-queue.json';
import type { PageDefinition } from '@/engine/types';

function readFilterParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

function readStatusParam(value: unknown): string {
  if (typeof value !== 'string') return 'pending';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'pending';
}

function readOptionalParam(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export const Route = createFileRoute('/ops/billing-updates')({
  validateSearch: (search: Record<string, unknown>) => ({
    requestType: readFilterParam(search.requestType),
    status: readStatusParam(search.status),
    requestId: readOptionalParam(search.requestId),
    reviewAction: readOptionalParam(search.reviewAction),
  }),
  component: BillingUpdateQueuePage,
});

interface BillingUpdateQueueScreenProps {
  requestType?: string;
  status?: string;
  requestId?: string;
  reviewAction?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function BillingUpdateQueueScreen({
  requestType = '%',
  status = 'pending',
  requestId = '',
  reviewAction = '',
  onStateChange,
}: BillingUpdateQueueScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(opsBillingUpdateQueuePage as PageDefinition),
      state: {
        ...(opsBillingUpdateQueuePage as PageDefinition).state,
        requestTypeFilter: requestType,
        statusFilter: status,
        selectedRequestId: requestId,
        selectedReviewAction: reviewAction,
      },
    }),
    [requestType, status, requestId, reviewAction],
  );

  return (
    <UIEngine
      key="billing-update-queue"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

export function BillingUpdateQueuePage() {
  const { requestType, status, requestId, reviewAction } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          requestType:
            typeof nextState.requestTypeFilter === 'string'
              ? nextState.requestTypeFilter
              : requestType,
          status:
            typeof nextState.statusFilter === 'string'
              ? nextState.statusFilter
              : status,
          requestId:
            typeof nextState.selectedRequestId === 'string'
              ? nextState.selectedRequestId
              : requestId,
          reviewAction:
            typeof nextState.selectedReviewAction === 'string'
              ? nextState.selectedReviewAction
              : reviewAction,
        },
        replace: true,
      });
    },
    [navigate, requestType, status, requestId, reviewAction],
  );

  return (
    <BillingUpdateQueueScreen
      requestType={requestType}
      status={status}
      requestId={requestId}
      reviewAction={reviewAction}
      onStateChange={handleStateChange}
    />
  );
}
