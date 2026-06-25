/**
 * UIEngine Component
 *
 * Main orchestrator that interprets page definitions and renders component trees
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { UIEngineContext } from './UIEngineContext';
import { ComponentRenderer } from './ComponentRenderer';
import { EngineErrorBoundary } from './EngineErrorBoundary';
import { useDataSources } from './useDataSources';
import { createActionDispatcher } from './ActionDispatcher';
import {
  evaluateExpression,
  createExpressionContext,
  mergeContext,
} from './ExpressionEvaluator';
import { supabase } from '@/data/supabase';
import { useAuthCapabilities } from '@/auth/AuthContext';
import type {
  PageDefinition,
  ExpressionContext,
  ActionDefinition,
  UIEngineContextValue,
} from './types';

interface UIEngineProps {
  /** The page definition to render */
  page: PageDefinition;
  /** Route parameters */
  params?: Record<string, string>;
  /** Optional callback fired when page state changes */
  onStateChange?: (
    nextState: Record<string, unknown>,
    previousState: Record<string, unknown>
  ) => void;
}

/** Reads a sessionStorage persistence entry and merges it with page defaults. */
function readPersistedEntry(
  key: string,
  pageDefaults: Record<string, unknown> | undefined
): { state: Record<string, unknown>; modals: Record<string, { props?: Record<string, unknown> }> } | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: Record<string, unknown>;
      modals?: Record<string, { props?: Record<string, unknown> }>;
    };
    return {
      state: { ...(pageDefaults || {}), ...(parsed.state || {}) },
      modals: parsed.modals || {},
    };
  } catch {
    return null;
  }
}

/**
 * UIEngine - Interprets JSON page definitions and renders component trees
 */
export function UIEngine({ page, params = {}, onStateChange }: UIEngineProps) {
  // Persistence key scoped to page + serialised route params so different contract pages
  // don't collide.  Recomputed whenever the serialised params string changes so a SPA
  // navigation from contract-1 to contract-2 (same component mount, new params) picks up
  // the correct key immediately rather than staying frozen on the initial value.
  const paramsKey = JSON.stringify(params);
  const persistenceKey = useMemo(
    () => `uiengine:${page.id}:${paramsKey}`,
    [page.id, paramsKey]
  );

  // Initialize page state — restore from sessionStorage when there is an in-progress workflow
  const [state, setStateInternal] = useState<Record<string, unknown>>(
    () => readPersistedEntry(persistenceKey, page.state)?.state ?? page.state ?? {}
  );

  // Modal state — restore open modals from sessionStorage on mount
  const [openModals, setOpenModals] = useState<
    Record<string, { props?: Record<string, unknown> }>
  >(
    () => readPersistedEntry(persistenceKey, page.state)?.modals ?? {}
  );
  const stateRef = useRef(state);
  const openModalsRef = useRef(openModals);
  const persistenceKeyRef = useRef(persistenceKey);
  const persistWorkflowState = useCallback(
    (
      nextState: Record<string, unknown> = stateRef.current,
      nextModals: Record<string, { props?: Record<string, unknown> }> = openModalsRef.current,
      nextPersistenceKey: string = persistenceKeyRef.current
    ) => {
      try {
        if (Object.keys(nextModals).length > 0) {
          sessionStorage.setItem(
            nextPersistenceKey,
            JSON.stringify({ state: nextState, modals: nextModals })
          );
        } else {
          sessionStorage.removeItem(nextPersistenceKey);
        }
      } catch {
        // sessionStorage unavailable — skip persistence silently
      }
    },
    []
  );

  // Detect param changes (SPA navigation without unmount).  When the key changes we:
  //   1. Remove the old entry so a future mount with the old params starts clean.
  //   2. Either restore persisted state from the new key or reset to page defaults.
  const prevPersistenceKeyRef = useRef(persistenceKey);
  useEffect(() => {
    const prevKey = prevPersistenceKeyRef.current;
    if (prevKey === persistenceKey) return;

    try {
      sessionStorage.removeItem(prevKey);
    } catch {
      // sessionStorage unavailable — skip
    }
    prevPersistenceKeyRef.current = persistenceKey;
    persistenceKeyRef.current = persistenceKey;

    const restored = readPersistedEntry(persistenceKey, page.state);
    if (restored) {
      stateRef.current = restored.state;
      openModalsRef.current = restored.modals;
      setStateInternal(restored.state);
      setOpenModals(restored.modals);
    } else {
      stateRef.current = page.state ?? {};
      openModalsRef.current = {};
      setStateInternal(page.state ?? {});
      setOpenModals({});
    }
  }, [persistenceKey, page.state]);

  useEffect(() => {
    stateRef.current = state;
    openModalsRef.current = openModals;
    persistenceKeyRef.current = persistenceKey;
  }, [state, openModals, persistenceKey]);

  // Router navigation
  const navigate = useNavigate();

  // Query client for cache invalidation
  const queryClient = useQueryClient();

  // Auth capabilities for role-gating
  const auth = useAuthCapabilities();

  // Create base expression context
  const baseContext = useMemo<ExpressionContext>(
    () =>
      createExpressionContext({
        state,
        params,
        auth,
      }),
    [state, params, auth]
  );

  // Fetch data sources
  const { data, isLoading, errors, isPageLoading, refetch } = useDataSources(
    page.dataSources,
    baseContext
  );

  // Full context with data
  const fullContext = useMemo<ExpressionContext>(
    () =>
      mergeContext(baseContext, {
        data,
        isLoading,
        errors,
        isPageLoading,
      }),
    [baseContext, data, isLoading, errors, isPageLoading]
  );

  // State setter
  const setState = useCallback((key: string, value: unknown) => {
    const prev = stateRef.current;
    const next = {
      ...prev,
      [key]: value,
    };
    stateRef.current = next;
    onStateChange?.(next, prev);
    persistWorkflowState(next, openModalsRef.current);
    setStateInternal(next);
  }, [onStateChange, persistWorkflowState]);

  // Modal handlers
  const openModal = useCallback(
    (modalId: string, props?: Record<string, unknown>) => {
      setOpenModals((prev) => {
        const next = {
          ...prev,
          [modalId]: { props },
        };
        openModalsRef.current = next;
        persistWorkflowState(stateRef.current, next);
        return next;
      });
    },
    [persistWorkflowState]
  );

  const closeModal = useCallback((modalId?: string) => {
    if (modalId) {
      setOpenModals((prev) => {
        const next = { ...prev };
        delete next[modalId];
        openModalsRef.current = next;
        persistWorkflowState(stateRef.current, next);
        return next;
      });
    } else {
      openModalsRef.current = {};
      persistWorkflowState(stateRef.current, {});
      setOpenModals({});
    }
  }, [persistWorkflowState]);

  // Persist state + open modals to sessionStorage while a workflow modal is in progress.
  // Cleared when all modals are closed so a fresh visit starts clean.
  // Intentionally runs on every state change while a modal is open: page-level form
  // fields are small strings (line IDs, dates) so the serialization cost is negligible,
  // and this ensures the most recent date or ID typed survives a reload mid-workflow.
  useEffect(() => {
    persistWorkflowState(state, openModals, persistenceKey);
  }, [state, openModals, persistenceKey, persistWorkflowState]);

  // Create action dispatcher
  const actionDispatcher = useMemo(
    () => {
      const resolveDecisionFinding = (context: ExpressionContext) =>
        (context.data as { finding?: { workflow_id?: string; run_id?: string } } | undefined)?.finding;

      return createActionDispatcher({
        setState,
        navigate,
        supabase,
        queryClient,
        refetch,
        openModal,
        closeModal,
        customHandlers: {
          async opsApproveFinding(payload, context) {
            const typedPayload = payload as
              | {
                findingId?: string;
                note?: string;
                refetchSources?: string[];
                workflowId?: string;
                runId?: string;
              }
              | undefined;
            const finding = resolveDecisionFinding(context);
            const findingId = String(
              typedPayload?.findingId ||
              context.params.findingId ||
              ''
            );
            if (!findingId) return;

            const note = String(typedPayload?.note || '').trim() || undefined;
            const workflowId = typedPayload?.workflowId || finding?.workflow_id;
            const runId = typedPayload?.runId || finding?.run_id;
            const approverId = String(context.state.approverId || '').trim() || undefined;
            const { data: { session: activeSession } } = await supabase.auth.getSession();
            const token = activeSession?.access_token || String(context.state.accessToken || '');
            const refetchSources = typedPayload?.refetchSources || ['finding', 'audit'];

            setState('actionError', null);
            setState('isSubmitting', true);
            setState('findingStatusOverride', 'approved');

            try {
              const response = await fetch(
                '/api/ops/findings/decision',
                {
                  method: 'POST',
                  headers: {
                    ...(token ? { Authorization: 'Bearer ' + token } : {}),
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    finding_id: findingId,
                    workflow_id: workflowId,
                    run_id: runId,
                    decision: 'approve',
                    approver_id: approverId,
                    note,
                  }),
                }
              );

              if (!response.ok) {
                throw new Error(`Approve failed: ${response.status}`);
              }

              void queryClient.invalidateQueries({ queryKey: ['datasource', 'findings'] });
              refetchSources.forEach((source) => refetch(source));
            } catch (error) {
              setState('findingStatusOverride', null);
              setState('actionError', error instanceof Error ? error.message : 'Approval failed');
            } finally {
              setState('isSubmitting', false);
            }
          },
          async opsRejectFinding(payload, context) {
            const typedPayload = payload as
              | {
                findingId?: string;
                reason?: string;
                refetchSources?: string[];
                workflowId?: string;
                runId?: string;
              }
              | undefined;
            const finding = resolveDecisionFinding(context);
            const findingId = String(
              typedPayload?.findingId ||
              context.params.findingId ||
              ''
            );
            if (!findingId) return;

            const reason = String(typedPayload?.reason || '').trim();
            if (!reason) {
              setState('actionError', 'Reject reason is required.');
              return;
            }
            const workflowId = typedPayload?.workflowId || finding?.workflow_id;
            const runId = typedPayload?.runId || finding?.run_id;
            const approverId = String(context.state.approverId || '').trim() || undefined;
            const { data: { session: activeSession } } = await supabase.auth.getSession();
            const token = activeSession?.access_token || String(context.state.accessToken || '');
            const refetchSources = typedPayload?.refetchSources || ['finding', 'audit'];

            setState('actionError', null);
            setState('isSubmitting', true);
            setState('findingStatusOverride', 'rejected');

            try {
              const response = await fetch(
                '/api/ops/findings/decision',
                {
                  method: 'POST',
                  headers: {
                    ...(token ? { Authorization: 'Bearer ' + token } : {}),
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    finding_id: findingId,
                    workflow_id: workflowId,
                    run_id: runId,
                    decision: 'reject',
                    approver_id: approverId,
                    reason,
                  }),
                }
              );

              if (!response.ok) {
                throw new Error(`Reject failed: ${response.status}`);
              }

              void queryClient.invalidateQueries({ queryKey: ['datasource', 'findings'] });
              refetchSources.forEach((source) => refetch(source));
            } catch (error) {
              setState('findingStatusOverride', null);
              setState('actionError', error instanceof Error ? error.message : 'Rejection failed');
            } finally {
              setState('isSubmitting', false);
            }
          },
          async generateMaintenanceInvoice(payload, context) {
            const typedPayload = payload as
              | {
                maintenanceRecordId?: string;
                billingAccountId?: string;
                workOrderStatus?: string;
                sellSubtotal?: number | string;
                taxTotal?: number | string;
                sellTotal?: number | string;
              }
              | undefined;

            const maintenanceRecordId = String(
              typedPayload?.maintenanceRecordId || context.params.id || ''
            ).trim();
            const billingAccountId = String(typedPayload?.billingAccountId || '').trim();
            if (!maintenanceRecordId || !billingAccountId) return;

            const token = String(context.state.accessToken || '').trim();
            if (!token) {
              setState('invoiceError', 'Authentication required to generate an invoice.');
              return;
            }

            setState('invoiceGenerating', true);
            setState('invoiceError', null);

            try {
              const response = await fetch(
                `/api/maintenance/work-orders/${maintenanceRecordId}/generate-invoice`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: 'Bearer ' + token,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    billing_account_id: billingAccountId,
                    work_order_status: String(typedPayload?.workOrderStatus || ''),
                    sell_subtotal: Number(typedPayload?.sellSubtotal ?? 0),
                    tax_total: Number(typedPayload?.taxTotal ?? 0),
                    sell_total: Number(typedPayload?.sellTotal ?? 0),
                  }),
                }
              );

              if (!response.ok) {
                throw new Error(`Invoice generation failed: ${response.status}`);
              }

              void queryClient.invalidateQueries({ queryKey: ['datasource'] });
              // These source names must match maintenance-work-order-detail.json dataSources keys
              refetch('workOrder');
              refetch('workOrderInvoiceRelationship');
            } catch (error) {
              setState('invoiceError', error instanceof Error ? error.message : 'Invoice generation failed');
            } finally {
              setState('invoiceGenerating', false);
            }
          },
        },
      });
    },
    [setState, navigate, queryClient, refetch, openModal, closeModal]
  );

  // Dispatch function that merges contexts
  const dispatch = useCallback(
    async (
      action: ActionDefinition,
      additionalContext?: Partial<ExpressionContext>
    ) => {
      const context = additionalContext
        ? mergeContext(fullContext, additionalContext)
        : fullContext;
      await actionDispatcher.dispatch(action, context);
    },
    [actionDispatcher, fullContext]
  );

  // Expression evaluator for child components
  const evalExpression = useCallback(
    (expr: unknown, additionalContext?: Partial<ExpressionContext>) => {
      const context = additionalContext
        ? mergeContext(fullContext, additionalContext)
        : fullContext;
      return evaluateExpression(expr, context);
    },
    [fullContext]
  );

  // Build context value
  const contextValue = useMemo<UIEngineContextValue>(
    () => ({
      state,
      setState,
      data,
      params,
      isLoading,
      errors,
      isPageLoading,
      dispatch,
      refetch,
      openModals,
      openModal,
      closeModal,
      evaluateExpression: evalExpression,
    }),
    [
      state,
      setState,
      data,
      params,
      isLoading,
      errors,
      isPageLoading,
      dispatch,
      refetch,
      openModals,
      openModal,
      closeModal,
      evalExpression,
    ]
  );

  return (
    <UIEngineContext.Provider value={contextValue}>
      {/* Render main layout — error boundary prevents a render crash from blanking the page */}
      <EngineErrorBoundary>
        <ComponentRenderer definition={page.layout} context={fullContext} />
      </EngineErrorBoundary>

      {/* Render modals */}
      {page.modals &&
        Object.entries(openModals).map(([modalId, modalState]) => {
          const modalDef = page.modals?.[modalId];
          if (!modalDef) return null;

          // Create context with modal props
          const modalContext = mergeContext(fullContext, {
            state: { ...state, ...(modalState.props || {}) },
          });

          return (
            <ModalRenderer
              key={modalId}
              modalId={modalId}
              definition={modalDef}
              context={modalContext}
              onClose={() => closeModal(modalId)}
            />
          );
        })}
    </UIEngineContext.Provider>
  );
}

/**
 * Modal Renderer Component
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ModalDefinition } from './types';

interface ModalRendererProps {
  modalId: string;
  definition: ModalDefinition;
  context: ExpressionContext;
  onClose: () => void;
}

function ModalRenderer({
  definition,
  context,
  onClose,
}: ModalRendererProps) {
  const title = definition.title
    ? (evaluateExpression(definition.title, context) as string)
    : undefined;

  const description = definition.description
    ? (evaluateExpression(definition.description, context) as string)
    : undefined;

  const sizeClasses: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    full: 'max-w-full',
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={sizeClasses[definition.size || 'md']}>
        {(title || description) && (
          <DialogHeader>
            {title && <DialogTitle>{title}</DialogTitle>}
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
        )}
        <ComponentRenderer definition={definition.content} context={context} />
      </DialogContent>
    </Dialog>
  );
}
